"""Fetching, HTML-to-text, Jev and OpenRouter calls for the official-site pilot."""
import hashlib
import json
import os
import re
import threading
import time
import urllib.parse
import urllib.request

from bs4 import BeautifulSoup

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
CACHE = os.path.join(HERE, 'cache')
UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
TYPESAFE_URL = 'https://api.typesafe.ai/v1/systemone'
OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
RETRYABLE = {408, 429, 500, 502, 503, 504, 529}


def load_env():
    path = os.path.join(ROOT, '.env')
    if os.path.exists(path):
        for line in open(path):
            if '=' in line and not line.lstrip().startswith('#'):
                k, v = line.strip().split('=', 1)
                os.environ.setdefault(k, v)


class Ledger:
    """Counts calls, tokens, cost and wall time per provider."""

    def __init__(self):
        self.lock = threading.Lock()
        self.rows = {}

    def add(self, provider, usage, seconds):
        with self.lock:
            r = self.rows.setdefault(provider, {'calls': 0, 'prompt_tokens': 0, 'completion_tokens': 0, 'cost': 0.0, 'seconds': 0.0})
            r['calls'] += 1
            r['seconds'] += seconds
            usage = usage or {}
            r['prompt_tokens'] += int(usage.get('prompt_tokens') or usage.get('input_tokens') or 0)
            r['completion_tokens'] += int(usage.get('completion_tokens') or usage.get('output_tokens') or 0)
            r['cost'] += float(usage.get('cost') or 0)


LEDGER = Ledger()


def fetch(url, headers=None, max_age=6 * 3600):
    """GET with a small on-disk cache so reruns of the pilot don't hit the sites again."""
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, hashlib.sha1(url.encode()).hexdigest()[:16])
    if os.path.exists(path) and time.time() - os.path.getmtime(path) < max_age:
        return open(path, 'rb').read()
    req = urllib.request.Request(url, headers={'User-Agent': UA, **(headers or {})})
    with urllib.request.urlopen(req, timeout=40) as r:
        body = r.read()
    open(path, 'wb').write(body)
    time.sleep(0.5)
    return body


def page_text(html, base_url, limit=40000):
    """Readable text of a page with links and images kept inline as [text](url) / ![alt](src)."""
    soup = BeautifulSoup(html, 'html.parser')
    for t in soup(['script', 'style', 'noscript', 'svg', 'iframe', 'header', 'footer', 'nav', 'form']):
        t.decompose()
    for img in soup.find_all('img'):
        src = img.get('data-src') or img.get('src') or ''
        if src and not src.startswith('data:'):
            img.replace_with(f" ![{img.get('alt', '').strip()}]({urllib.parse.urljoin(base_url, src)}) ")
        else:
            img.decompose()
    for a in soup.find_all('a'):
        href = a.get('href') or ''
        text = ' '.join(a.get_text(' ').split())
        if href and not href.startswith(('#', 'javascript:', 'mailto:')) and text:
            a.replace_with(f' [{text}]({urllib.parse.urljoin(base_url, href)}) ')
    text = soup.get_text('\n')
    text = re.sub(r'[ \t　]+', ' ', text)
    text = re.sub(r'\n\s*\n+', '\n', text).strip()
    return text[:limit]


def _post(url, key, body, provider, attempts=4):
    data = json.dumps(body).encode()
    for attempt in range(attempts):
        started = time.time()
        req = urllib.request.Request(url, data=data, headers={'Authorization': f'Bearer {key}', 'Content-Type': 'application/json'})
        try:
            with urllib.request.urlopen(req, timeout=180) as r:
                result = json.loads(r.read())
            LEDGER.add(provider, result.get('usage'), time.time() - started)
            return result
        except urllib.error.HTTPError as e:
            if e.code not in RETRYABLE or attempt == attempts - 1:
                raise RuntimeError(f'{provider} HTTP {e.code}: {e.read()[:300]!r}')
        except (urllib.error.URLError, TimeoutError) as e:
            if attempt == attempts - 1:
                raise RuntimeError(f'{provider} transport error: {e!r}')
        time.sleep(1.5 * 2 ** attempt)


def jev_choice(task, questions, batch=20):
    """questions: {qid: {"criteria": [...], "instructions": {...}}} → {qid: (best label, probability)}."""
    key = os.environ['TYPESAFE_API_KEY']
    model = os.environ.get('TYPESAFE_MODEL') or 'jev-latest'
    out = {}
    ids = list(questions)
    for i in range(0, len(ids), batch):
        chunk = {q: {'type': 'choice', **questions[q]} for q in ids[i:i + batch]}
        result = _post(TYPESAFE_URL, key, {'model': model, 'state': {'task': task}, 'questions': chunk}, 'jev')
        for q, ans in (result.get('answers') or {}).items():
            probs = (ans or {}).get('probabilities') or {}
            if probs:
                best = max(probs, key=probs.get)
                out[q] = (best, float(probs[best]))
    return out


def llm_json(system, user, max_tokens=6000):
    key = os.environ['OPENROUTER_API_KEY']
    model = os.environ.get('OFFICIAL_LLM_MODEL') or 'google/gemini-3.1-flash-lite'
    result = _post(OPENROUTER_URL, key, {
        'model': model, 'temperature': 0, 'max_tokens': max_tokens, 'response_format': {'type': 'json_object'},
        'usage': {'include': True}, 'reasoning': {'enabled': False},
        'messages': [{'role': 'system', 'content': system}, {'role': 'user', 'content': user}],
    }, 'openrouter')
    content = (result.get('choices') or [{}])[0].get('message', {}).get('content') or '{}'
    content = re.sub(r'^```(?:json)?|```$', '', content.strip()).strip()
    return json.loads(content)
