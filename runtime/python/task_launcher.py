"""Owned task child: impose a hard inherited per-file bound before Node/Python IO."""
import os
import resource
import sys

ceiling = int(sys.argv[1])
resource.setrlimit(resource.RLIMIT_FSIZE, (ceiling, ceiling))
os.execv(sys.argv[2], sys.argv[2:])
