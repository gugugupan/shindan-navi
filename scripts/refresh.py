"""Refresh the release data in one go: collect → merge → build → verify, then print a review packet.

  python3 -I scripts/refresh.py                  # full run (official collector + enrich only with API keys)
  python3 -I scripts/refresh.py --skip-collect   # reuse today's data/releases: merge + build + verify (after manual fixes)
  python3 -I scripts/refresh.py --dry-run        # collect, merge --dry-run (report only), stop before the build
  python3 -I scripts/refresh.py --no-official    # aggregators only: no official collector, no official merge, no enrich

TODAY (env, else today in Asia/Tokyo) is fixed once and passed to every step. The merge always starts from HEAD's
data/items.json and meta.json, so a re-run reports against the committed data, not against the previous run.
Stops at the first failing step with its exit code. Never commits or pushes. The packet and per-step logs go to
out/refresh-<TODAY>/ (git-ignored).
"""
import argparse
import datetime
import json
import os
import re
import shutil
import subprocess
import sys
import zoneinfo

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VENV_PY = os.path.join(ROOT, '.venv/bin/python')
COLLECTORS = os.path.join(ROOT, 'tools/release-collectors')
RELEASES = os.path.join(ROOT, 'data/releases')
VERIFY_DIR = os.path.join(ROOT, 'tools/verify')
SCREENSHOTS = os.path.join(ROOT, '.verify')
CHROME = os.environ.get('CHROME') or '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
BASE = 'origin/main'
KEYS = ('TYPESAFE_API_KEY', 'OPENROUTER_API_KEY')


def git(*args, check=True):
    r = subprocess.run(['git', '-C', ROOT, *args], capture_output=True, text=True)
    if check and r.returncode:
        sys.exit(f'git {" ".join(args)} failed: {r.stderr.strip()}')
    return r.stdout.strip() if r.returncode == 0 else None


def env_keys():
    """Which API keys are set (env or .env, as official/common.load_env reads them); values are never read out."""
    found = {k for k in KEYS if os.environ.get(k)}
    path = os.path.join(ROOT, '.env')
    if os.path.exists(path):
        for line in open(path):
            k, sep, v = line.strip().partition('=')
            if sep and not k.startswith('#') and k in KEYS and v:
                found.add(k)
    return found


def check_worktree():
    git_dir = os.path.realpath(os.path.join(ROOT, git('rev-parse', '--git-dir')))
    common = os.path.realpath(os.path.join(ROOT, git('rev-parse', '--git-common-dir')))
    branch = git('branch', '--show-current') or '(detached)'
    if git_dir == common:
        if branch in ('main', 'master'):
            sys.exit(f'refusing to run in the main checkout on {branch}: create a worktree first '
                     f'(git -C {ROOT} worktree add ../.worktrees/<branch> -b <branch>)')
        print(f'WARNING: {ROOT} is the main checkout (branch {branch}), not a worktree. Data updates belong in a worktree.')
    return branch


def check_prereqs(args, keys):
    errors = []
    if not os.path.exists(VENV_PY):
        errors.append('missing .venv: python3 -m venv .venv && .venv/bin/pip install fonttools brotli pillow')
    else:
        if subprocess.run([VENV_PY, '-I', '-c', 'import PIL'], capture_output=True).returncode:
            errors.append('.venv has no Pillow: .venv/bin/pip install pillow')
        official_collect = not args.skip_collect and not args.no_official and len(keys) == len(KEYS)
        enrich = not args.no_official and 'OPENROUTER_API_KEY' in keys
        if (official_collect or enrich) and subprocess.run([VENV_PY, '-I', '-c', 'import bs4'], capture_output=True).returncode:
            errors.append('.venv has no bs4 (needed by the official collector / enrich with the API keys set): '
                          '.venv/bin/pip install beautifulsoup4')
    if not args.dry_run:
        node = shutil.which('node')
        if not node:
            errors.append('node not found (Node >= 20 runs tools/verify/browser.mjs)')
        else:
            v = subprocess.run([node, '--version'], capture_output=True, text=True).stdout.strip()
            if not re.match(r'v(\d+)', v) or int(re.match(r'v(\d+)', v).group(1)) < 20:
                errors.append(f'node {v} is too old: Node >= 20 needed')
        if not os.path.isdir(os.path.join(VERIFY_DIR, 'node_modules/playwright-core')):
            errors.append('tools/verify has no node_modules: (cd tools/verify && npm ci)')
        if not os.path.exists(CHROME):
            errors.append(f'Chrome not found at {CHROME} (set CHROME=/path/to/chrome)')
        if git('rev-parse', '--verify', '--quiet', BASE, check=False) is None:
            errors.append(f'{BASE} not found: git fetch origin main')
    if errors:
        sys.exit('prerequisites missing:\n  - ' + '\n  - '.join(errors))


def run_step(name, cmd, env, logdir, n):
    """Streams the step's output to the terminal and logs it; returns (exit code, output)."""
    log = os.path.join(logdir, f'{n}-{name}.log')
    print(f'\n=== {n}. {name}: {" ".join(os.path.relpath(c, ROOT) if c.startswith(ROOT) else c for c in cmd)}', flush=True)
    out = []
    with open(log, 'w') as f:
        p = subprocess.Popen(cmd, cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        for line in p.stdout:
            sys.stdout.write(line)
            f.write(line)
            out.append(line)
        p.wait()
    return p.returncode, ''.join(out)


def reset_merge_base(logdir):
    """data/items.json and meta.json back to HEAD so the merge (and its report) is against the committed data."""
    for rel in ('data/items.json', 'data/meta.json'):
        head = subprocess.run(['git', '-C', ROOT, 'show', f'HEAD:{rel}'], capture_output=True).stdout
        path = os.path.join(ROOT, rel)
        cur = open(path, 'rb').read() if os.path.exists(path) else None
        if cur != head:
            if cur is not None:
                backup = os.path.join(logdir, os.path.basename(rel) + '.before-refresh')
                open(backup, 'wb').write(cur)
                print(f'{rel} differed from HEAD: restored from HEAD (previous copy: {os.path.relpath(backup, ROOT)})')
            open(path, 'wb').write(head)


def collector_lines(today, sources):
    lines = []
    for src in ('cardlabo', 'torecamap', 'official'):
        path = os.path.join(RELEASES, src, '_run.json')
        if src in sources.get('skipped', {}):
            lines.append(f'- {src}: skipped ({sources["skipped"][src]})')
            continue
        if not os.path.exists(path):
            lines.append(f'- {src}: no _run.json')
            continue
        run = json.load(open(path))
        stale = '' if run.get('today') == today else f' — STALE (today {run.get("today")}, not {today})'
        extra = []
        if run.get('errors'):
            extra.append(f'{len(run["errors"])} errors')
        if run.get('unknown_labels'):
            extra.append('unknown_labels: ' + ', '.join(run['unknown_labels']))
        lines.append(f'- {src}: {run.get("record_count")} records, complete {str(run.get("complete")).lower()}, '
                     f'fetched_at {run.get("fetched_at")}' + (f' ({"; ".join(extra)})' if extra else '') + stale)
    return lines


def report_lines():
    """Section counts of data/update-report.md, plus its summary lines and the official log."""
    text = open(os.path.join(ROOT, 'data/update-report.md')).read()
    lines, section, bullets = [], None, []

    def flush():
        if section is None:
            return
        m = re.match(r'(.+?)（(\d+)）$', section)
        if section == '公式サイト取得ログ':
            lines.append(f'- {section}:')
            lines.extend(f'  {b}' for b in bullets)
        elif m:
            lines.append(f'- {m.group(1).split("（")[0]}: {m.group(2)}')
        else:
            lines.append(f'- {section.split("（")[0]}: {len(bullets)}')
    for line in text.splitlines():
        if line.startswith('## '):
            flush()
            section, bullets = line[3:].strip(), []
        elif section is None and line.startswith('- '):
            lines.append(line)
        elif section is not None and line.startswith('- '):
            bullets.append(line)
    flush()
    return lines


def diff_lines():
    stat = git('diff', '--stat', 'HEAD', '--', 'data', check=False) or '(no changes to tracked files)'
    status = (git('diff', '--name-status', 'HEAD', '--', 'public/thumbs', check=False) or '').splitlines()
    deleted = sum(1 for s in status if s.startswith('D'))
    untracked = (git('ls-files', '--others', '--exclude-standard', '--', 'data', 'public/thumbs', check=False) or '').splitlines()
    return ['```', stat, '```', f'- public/thumbs: {len(untracked)} new, {deleted} deleted (unreferenced), '
            f'{len(status) - deleted} modified' + (' — new: ' + ', '.join(os.path.basename(u) for u in untracked[:8])
                                                    + (' …' if len(untracked) > 8 else '') if untracked else '')]


def item_change_lines(today):
    """Per-field changes of items.json vs HEAD: the report lists only some of them (not sources, box, price writing)."""
    old = {i['id']: i for i in json.loads(subprocess.run(['git', '-C', ROOT, 'show', 'HEAD:data/items.json'],
                                                         capture_output=True, text=True).stdout)}
    new = {i['id']: i for i in json.load(open(os.path.join(ROOT, 'data/items.json')))}
    fields, lost_official = {}, 0
    for k in old.keys() & new.keys():
        for f in set(old[k]) | set(new[k]):
            if old[k].get(f) != new[k].get(f):
                fields[f] = fields.get(f, 0) + 1
        if 'official' in old[k].get('sources', []) and 'official' not in new[k].get('sources', []) and new[k]['date'] >= today:
            lost_official += 1
    lines = [f'- items.json vs HEAD: {len(new.keys() - old.keys())} added, {len(old.keys() - new.keys())} removed; changed fields: '
             + (', '.join(f'{f} {n}' for f, n in sorted(fields.items(), key=lambda x: -x[1])) or 'none')]
    if lost_official:
        # a skipped official step keeps "official"; only a run that checked and did not match loses it
        lines.append(f'- WARNING: {lost_official} upcoming items lost "official" from sources: the official step ran '
                     'and did not match them (gone from the official site, or a missed match)')
    return lines


def main():
    ap = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0],
                                 formatter_class=argparse.RawDescriptionHelpFormatter, epilog=__doc__.split('\n', 2)[2])
    ap.add_argument('--skip-collect', action='store_true', help="reuse today's data/releases; merge + build + verify only")
    ap.add_argument('--dry-run', action='store_true', help='merge --dry-run (report only), then stop before the build')
    ap.add_argument('--no-official', action='store_true', help='no official collector, official merge or enrich')
    args = ap.parse_args()

    today = os.environ.get('TODAY') or datetime.datetime.now(zoneinfo.ZoneInfo('Asia/Tokyo')).date().isoformat()
    try:
        datetime.date.fromisoformat(today)
    except ValueError:
        sys.exit(f'TODAY must be YYYY-MM-DD, got {today!r}')
    branch = check_worktree()
    keys = env_keys()
    check_prereqs(args, keys)
    logdir = os.path.join(ROOT, 'out', f'refresh-{today}')
    os.makedirs(logdir, exist_ok=True)
    env = dict(os.environ, TODAY=today, BUILD_TODAY=today)
    print(f'TODAY {today} · branch {branch} · HEAD {git("rev-parse", "--short", "HEAD")} · '
          f'API keys: {", ".join(sorted(keys)) or "none"} · logs {os.path.relpath(logdir, ROOT)}/')

    base_sha = None
    if not args.dry_run:
        if subprocess.run(['git', '-C', ROOT, 'fetch', '--quiet', 'origin', 'main'], capture_output=True).returncode:
            print(f'WARNING: git fetch origin main failed; verifying against the local {BASE}')
        base_sha = git('rev-parse', '--short', BASE)

    py = [VENV_PY, '-I']
    sources = {'skipped': {}}
    steps = []
    if args.skip_collect:
        sources['collect'] = 'skipped (--skip-collect): reusing data/releases'
    else:
        steps += [('collect-cardlabo', py + [os.path.join(COLLECTORS, 'cardlabo/collect.py'), '--today', today]),
                  ('collect-torecamap', py + [os.path.join(COLLECTORS, 'torecamap/collect.py'), '--today', today])]
        if args.no_official:
            sources['skipped']['official'] = '--no-official'
        elif len(keys) < len(KEYS):
            sources['skipped']['official'] = 'no TYPESAFE_API_KEY / OPENROUTER_API_KEY'
        else:
            steps.append(('collect-official', py + [os.path.join(COLLECTORS, 'official/collect.py'), '--today', today]))
    merge = py + [os.path.join(ROOT, 'scripts/update_data.py')] + (['--dry-run'] if args.dry_run else []) \
        + (['--no-official'] if args.no_official else [])
    steps.append(('merge', merge))
    if not args.dry_run:
        steps += [('build', py + [os.path.join(ROOT, 'scripts/build.py')]),
                  ('verify-release', py + [os.path.join(ROOT, 'scripts/verify_release.py'), '--base', BASE, '--today', today, '--skip-build']),
                  ('verify-browser', ['node', os.path.join(VERIFY_DIR, 'browser.mjs'), '--today', today, '--out', SCREENSHOTS])]

    stopped, outputs = None, {}
    for n, (name, cmd) in enumerate(steps, 1):
        if name == 'merge':
            reset_merge_base(logdir)
        code, out = run_step(name, cmd, env, logdir, n)
        outputs[name] = out
        if code:
            stopped = (name, code)
            break

    packet = [f'# Refresh packet {today}', '',
              f'- branch {branch}, HEAD {git("rev-parse", "--short", "HEAD")}; flags: '
              + (' '.join(f'--{k.replace("_", "-")}' for k, v in vars(args).items() if v) or 'none'),
              f'- result: ' + (f'STOPPED at {stopped[0]} (exit {stopped[1]}); see its log' if stopped
                               else 'dry run complete (no build / verify)' if args.dry_run else 'all steps passed'),
              f'- logs: {logdir}/', '', '## Collectors', '']
    if args.skip_collect:
        packet.append(f'- {sources["collect"]}')
    packet += collector_lines(today, sources)
    if 'merge' in outputs and (not stopped or stopped[0] != 'merge'):
        packet += ['', '## Report (data/update-report.md)', ''] + report_lines()
    elif stopped and stopped[0] == 'merge':
        packet += ['', '## Merge refused', '', '```', outputs['merge'].strip()[-1500:], '```']
    if not args.dry_run and 'merge' in outputs and (not stopped or stopped[0] != 'merge'):
        packet += ['', '## Diff vs HEAD (data/, public/thumbs)', ''] + diff_lines() + item_change_lines(today)
    if 'verify-release' in outputs:
        vr = [l for l in outputs['verify-release'].splitlines() if l.startswith(('WARN', 'FAIL', 'RESULT'))]
        packet += ['', f'## Verify (base {BASE} {base_sha}, --today {today})', '', 'verify_release.py:'] + [f'  {l}' for l in vr]
    if 'verify-browser' in outputs:
        vb = [l for l in outputs['verify-browser'].splitlines() if l.startswith(('FAIL', 'RESULT'))]
        packet += ['browser.mjs:'] + [f'  {l}' for l in vb] + [f'- screenshots: {SCREENSHOTS}/']
    text = '\n'.join(packet) + '\n'
    path = os.path.join(logdir, 'packet.md')
    open(path, 'w').write(text)
    print('\n' + text + f'(saved to {path})')
    return stopped[1] if stopped else 0


if __name__ == '__main__':
    sys.exit(main())
