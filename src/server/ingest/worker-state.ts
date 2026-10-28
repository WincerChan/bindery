// Shared by the parent and worker. Admission and cancellation must race on the
// same atomic word: an "online" event says nothing about executor readiness.
export const WorkerState = { Starting: 0, Stopping: 1, Running: 2 } as const;
