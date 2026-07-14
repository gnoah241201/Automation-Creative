import { Counter, Gauge, Histogram, register } from 'prom-client';

// Job metrics
export const jobsCreated = new Counter({
  name: 'resize_video_jobs_created_total',
  help: 'Total number of jobs created',
  labelNames: ['status'],
});

export const jobsCompleted = new Counter({
  name: 'resize_video_jobs_completed_total',
  help: 'Total number of jobs completed',
  labelNames: ['status'],
});

export const jobsDuration = new Histogram({
  name: 'resize_video_job_duration_seconds',
  help: 'Job rendering duration in seconds',
  buckets: [10, 30, 60, 120, 300, 600, 1200, 3600],
});

export const queueSize = new Gauge({
  name: 'resize_video_queue_size',
  help: 'Current number of jobs in queue',
});

export const activeJobs = new Gauge({
  name: 'resize_video_active_jobs',
  help: 'Current number of jobs being processed',
});

export const failedJobs = new Counter({
  name: 'resize_video_jobs_failed_total',
  help: 'Total number of failed jobs',
});

export const cancelledJobs = new Counter({
  name: 'resize_video_jobs_cancelled_total',
  help: 'Total number of cancelled jobs',
});

// Upload metrics
export const uploadSize = new Histogram({
  name: 'resize_video_upload_bytes',
  help: 'Upload file size in bytes',
  buckets: [1024 * 1024, 10 * 1024 * 1024, 50 * 1024 * 1024, 100 * 1024 * 1024, 500 * 1024 * 1024],
});

// Export metrics endpoint
export const metricsEndpoint = async () => {
  return register.metrics();
};
