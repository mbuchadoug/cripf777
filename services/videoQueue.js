import Queue from "bull";
import { processVideoToHLS } from "./videoProcessor.js";
import path from "path";

// Create video processing queue
export const videoQueue = new Queue('video-processing', {
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: process.env.REDIS_PORT || 6379
  }
});

// Process video jobs
videoQueue.process(async (job) => {
  const { materialId, filePath } = job.data;
  
  console.log(`[VideoQueue] Processing job: ${job.id} for material ${materialId}`);
  
  try {
    // Update progress
    job.progress(10);
    
    // Process video
    const result = await processVideoToHLS(filePath, materialId);
    
    job.progress(90);
    
    // Update database
    const LearningMaterial = (await import("../models/learningMaterial.js")).default;
    
    await LearningMaterial.updateOne(
      { _id: materialId },
      {
        $set: {
          videoProcessingStatus: 'ready',
          streamUrl: result.streamUrl,
          thumbnailUrl: result.thumbnailUrl,
          duration: result.duration,
          status: 'active'
        }
      }
    );
    
    job.progress(100);
    
    console.log(`[VideoQueue] ✅ Job ${job.id} completed`);
    
    return result;
    
  } catch (error) {
    console.error(`[VideoQueue] ❌ Job ${job.id} failed:`, error);
    
    // Update database with error
    const LearningMaterial = (await import("../models/learningMaterial.js")).default;
    
    await LearningMaterial.updateOne(
      { _id: materialId },
      {
        $set: {
          videoProcessingStatus: 'failed',
          status: 'active' // Still show it, just without streaming
        }
      }
    );
    
    throw error;
  }
});

// Event handlers
videoQueue.on('completed', (job, result) => {
  console.log(`[VideoQueue] Job ${job.id} completed successfully`);
});

videoQueue.on('failed', (job, err) => {
  console.error(`[VideoQueue] Job ${job.id} failed:`, err.message);
});

videoQueue.on('progress', (job, progress) => {
  console.log(`[VideoQueue] Job ${job.id} progress: ${progress}%`);
});

/**
 * Add video to processing queue
 */
export async function queueVideoProcessing(materialId, filePath) {
  const job = await videoQueue.add(
    { materialId, filePath },
    {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 5000
      },
      removeOnComplete: true,
      timeout: 3600000 // 1 hour timeout
    }
  );
  
  console.log(`[VideoQueue] Queued job ${job.id} for material ${materialId}`);
  
  return job;
}