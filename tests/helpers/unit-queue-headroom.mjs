// Deterministic admission inputs for transport/DB unit integration tests.
// These tests run in a 512MiB bundle; a real 1GiB coordinator + separate512MiB
// worker topology is proved by the mandatory native governor/HTTP lab suites.
// This adapter is not evidence of cgroup headroom or real multi-worker capacity.
export const unitQueueResources={readMemory:async()=>({current:128*1048576,max:1024*1048576})};
