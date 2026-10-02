from pathlib import Path
import json

root = Path(r'd:\GitHub\development')
marker = 'mariowOS builder note'

for path in root.rglob('*'):
    if not path.is_file():
        continue
    if any(part in {'node_modules', '.git'} for part in path.parts):
        continue
    suffix = path.suffix.lower()
    if suffix in {'.js', '.html', '.md', '.bat'}:
        try:
            text = path.read_text(encoding='utf-8')
        except Exception:
            continue
        if marker in text:
            continue
        if suffix == '.js':
            insert = "// mariowOS builder note: This file is part of the runtime that powers the OS. It defines how the desktop, login flow, or app behavior is built for contributors.\n\n"
        elif suffix == '.html':
            insert = "<!-- mariowOS builder note: This file is part of the mariowOS interface. It helps builders understand how the OS shell or app UI is structured. -->\n\n"
        elif suffix == '.md':
            insert = "<!-- mariowOS builder note: This document explains how mariowOS is meant to be built, extended, and maintained by contributors. -->\n\n"
        elif suffix == '.bat':
            insert = ":: mariowOS builder note: This batch file starts the local mariowOS development environment for contributors.\n\n"
        path.write_text(insert + text, encoding='utf-8')

for rel in [Path('package.json'), Path('system/package.json'), Path('system/config.json'), Path('system/version.json')]:
    path = root / rel
    if not path.exists():
        continue
    try:
        data = json.loads(path.read_text(encoding='utf-8'))
    except Exception:
        continue
    if isinstance(data, dict) and '_comment' not in data:
        data['_comment'] = 'This configuration file belongs to the mariowOS project and is used by contributors building and running the OS.'
        path.write_text(json.dumps(data, indent=2) + '\n', encoding='utf-8')

print('Comment pass complete for source files and safe JSON config files.')
