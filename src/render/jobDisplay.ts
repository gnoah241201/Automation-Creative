export type QueueDisplayJob = {
  filename?: string;
  label: string;
};

export const getJobDisplayName = (job: QueueDisplayJob): string => {
  return job.filename || job.label;
};
