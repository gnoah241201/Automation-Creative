import { Counter, Gauge, Histogram, register } from 'prom-client';

const metric = <T>(name: string, create: () => T): T => (
  register.getSingleMetric(name) as T | undefined
) ?? create();

// Job metrics
export const jobsCreated = metric('resize_video_jobs_created_total', () => new Counter({
  name: 'resize_video_jobs_created_total',
  help: 'Total number of jobs created',
  labelNames: ['status'],
}));

export const jobsCompleted = metric('resize_video_jobs_completed_total', () => new Counter({
  name: 'resize_video_jobs_completed_total',
  help: 'Total number of jobs completed',
  labelNames: ['status'],
}));

export const jobsDuration = metric('resize_video_job_duration_seconds', () => new Histogram({
  name: 'resize_video_job_duration_seconds',
  help: 'Job rendering duration in seconds',
  buckets: [10, 30, 60, 120, 300, 600, 1200, 3600],
}));

export const queueSize = metric('resize_video_queue_size', () => new Gauge({
  name: 'resize_video_queue_size',
  help: 'Current number of jobs in queue',
}));

export const activeJobs = metric('resize_video_active_jobs', () => new Gauge({
  name: 'resize_video_active_jobs',
  help: 'Current number of jobs being processed',
}));

export const failedJobs = metric('resize_video_jobs_failed_total', () => new Counter({
  name: 'resize_video_jobs_failed_total',
  help: 'Total number of failed jobs',
}));

export const cancelledJobs = metric('resize_video_jobs_cancelled_total', () => new Counter({
  name: 'resize_video_jobs_cancelled_total',
  help: 'Total number of cancelled jobs',
}));

// Upload metrics
export const uploadSize = metric('resize_video_upload_bytes', () => new Histogram({
  name: 'resize_video_upload_bytes',
  help: 'Upload file size in bytes',
  buckets: [1024 * 1024, 10 * 1024 * 1024, 50 * 1024 * 1024, 100 * 1024 * 1024, 500 * 1024 * 1024],
}));

export const composerJobsCreated = metric('resize_video_composer_jobs_created_total', () => new Counter({
  name: 'resize_video_composer_jobs_created_total',
  help: 'Composer jobs created',
  labelNames: ['mode'],
}));

export const composerJobsCompleted = metric('resize_video_composer_jobs_completed_total', () => new Counter({
  name: 'resize_video_composer_jobs_completed_total',
  help: 'Composer jobs completed',
  labelNames: ['status'],
}));

export const composerPreviewCache = metric('resize_video_composer_preview_cache_total', () => new Counter({
  name: 'resize_video_composer_preview_cache_total',
  help: 'Exact preview cache results',
  labelNames: ['result'],
}));

export const composerLibraryBytes = metric('resize_video_composer_library_bytes', () => new Gauge({
  name: 'resize_video_composer_library_bytes',
  help: 'Bytes currently retained in local composer library',
}));

export const composerSourceTrimMutations = metric('resize_video_composer_source_trim_total', () => new Counter({
  name: 'resize_video_composer_source_trim_total',
  help: 'Composer source trim mutations',
  labelNames: ['status'],
}));

export const composerBulkApplyMutations = metric('resize_video_composer_bulk_apply_total', () => new Counter({
  name: 'resize_video_composer_bulk_apply_total',
  help: 'Composer bulk apply mutations',
  labelNames: ['scope', 'status'],
}));

export const composerLibraryBundles = metric('resize_video_composer_library_bundle_total', () => new Counter({
  name: 'resize_video_composer_library_bundle_total',
  help: 'Composer library ZIP bundles',
  labelNames: ['status'],
}));

// Export metrics endpoint
export const metricsEndpoint = async () => {
  return register.metrics();
};
