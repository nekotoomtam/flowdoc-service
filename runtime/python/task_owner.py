"""Lifetime task-store fence. Keep the lock until owned process groups are stopped."""
import fcntl
import json
import os
import signal
import stat
import sys
import time
import uuid

root = sys.argv[1]
parent = os.getppid()
groups = {}

def reply(value):
    print(json.dumps(value), flush=True)

def read_stat(pid):
    try:
        with open('/proc/' + str(pid) + '/stat', encoding='utf8') as source:
            fields = source.read().rsplit(')', 1)[1].strip().split()
        return fields
    except (FileNotFoundError, ProcessLookupError):
        return None

def members(pid, identity):
    leader = read_stat(pid)
    if leader and leader[19] != identity:
        return []  # The original group is gone; never signal a reused PID.
    found = []
    for name in os.listdir('/proc'):
        if not name.isdigit():
            continue
        row = read_stat(int(name))
        if row and int(row[2]) == pid and row[0] not in ('Z', 'X'):
            found.append(int(name))
    return found

def drain():
    # Recheck until confirmed. A failed stop never releases the ownership fence.
    while True:
        try:
            live = [(pid, identity) for pid, identity in groups.items() if members(pid, identity)]
        except Exception:
            time.sleep(.1)
            continue  # Unreadable process state must retain the fence.
        if not live:
            return
        for pid, _ in live:
            try:
                os.killpg(pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
        time.sleep(.02)

try:
    if stat.S_ISLNK(os.lstat(root).st_mode):
        raise RuntimeError('linked root')
    coordinator = os.open(os.path.join(root, '.runtime.lock'), os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(coordinator, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        reply({'event': 'busy'})
        sys.exit(75)
    fence = os.dup(3)  # Same open-file description retained by Node and render children.
    if not stat.S_ISREG(os.fstat(fence).st_mode):
        raise RuntimeError('invalid fence')
    try:
        fcntl.flock(fence, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        reply({'event': 'busy'})
        sys.exit(75)
    identity_path = os.path.join(root, '.storage-id')
    try:
        identity_fd = os.open(identity_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    except FileExistsError:
        identity_fd = os.open(identity_path, os.O_RDONLY | os.O_NOFOLLOW)
        if not stat.S_ISREG(os.fstat(identity_fd).st_mode):
            raise RuntimeError('invalid identity')
        with os.fdopen(identity_fd, encoding='ascii') as source:
            storage_id = str(uuid.UUID(source.read(64).strip()))
    else:
        storage_id = str(uuid.uuid4())
        with os.fdopen(identity_fd, 'w', encoding='ascii') as target:
            target.write(storage_id + '\n')
            target.flush()
            os.fsync(target.fileno())
    runtime_id = str(uuid.uuid4())
    runtime_fd = os.open(os.path.join(root, '.runtime-id'), os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(runtime_fd, 'w', encoding='ascii') as target:
        target.write(runtime_id + '\n')
        target.flush()
        os.fsync(target.fileno())
    fcntl.flock(fence, fcntl.LOCK_SH)
    reply({'event': 'ready', 'storageId': storage_id, 'runtimeId': runtime_id})
    try:
        for line in sys.stdin:
            command = json.loads(line)
            request = command['id']
            op = command['op']
            try:
                if op == 'register':
                    pid = command['pid']
                    if not isinstance(pid, int) or pid <= 1:
                        raise RuntimeError('invalid group')
                    row = read_stat(pid)
                    if not row or int(row[1]) != parent or int(row[2]) != pid:
                        raise RuntimeError('unowned group')
                    groups[pid] = row[19]
                elif op == 'unregister':
                    pid = command['pid']
                    if pid in groups and members(pid, groups[pid]):
                        raise RuntimeError('group still active')
                    groups.pop(pid, None)
                elif op == 'stop':
                    drain()
                    reply({'ack': request})
                    break
                else:
                    raise RuntimeError('invalid operation')
                reply({'ack': request})
            except Exception:
                reply({'ack': request, 'error': 'TASK_OWNER_UNAVAILABLE'})
    finally:
        drain()
        os.close(fence)
except Exception:
    reply({'event': 'error'})
    sys.exit(1)
