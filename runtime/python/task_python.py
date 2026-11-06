#!/usr/bin/env python
"""Keep every native task writer fenced, including after its Node parent dies."""
import fcntl
import os
import sys

root = os.environ['FLOWDOC_TASK_FENCE']
fence = os.open(os.path.join(root, '.writers.lock'), os.O_RDWR | os.O_NOFOLLOW)
fcntl.flock(fence, fcntl.LOCK_SH | fcntl.LOCK_NB)
identity = os.open(os.path.join(root, '.runtime-id'), os.O_RDONLY | os.O_NOFOLLOW)
with os.fdopen(identity, encoding='ascii') as source:
    if source.read(64).strip() != os.environ['FLOWDOC_TASK_RUNTIME']:
        sys.exit(75)  # A delayed spawn must never join a replacement runtime.
os.set_inheritable(fence, True)
os.execv(sys.executable, [sys.executable, *sys.argv[1:]])
