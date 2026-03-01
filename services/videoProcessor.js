import ffmpeg from "fluent-ffmpeg";
import path from "path";
import fs from "fs/promises";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Process video to HLS format with multiple quality levels
 */
export async function processVideoToHLS(inputPath, materialId) {
  const outputDir = path.join(process.cwd(), "public", "streams", String(materialId));
  
  // Create output directory
  await fs.mkdir(outputDir, { recursive: true });

  const playlistPath = path.join(outputDir, "playlist.m3u8");
  const thumbnailPath = path.join(outputDir, "thumbnail.jpg");

  return new Promise((resolve, reject) => {
    // Generate thumbnail first
    ffmpeg(inputPath)
      .screenshots({
        timestamps: ['10%'],
        filename: 'thumbnail.jpg',
        folder: outputDir,
        size: '1280x720'
      })
      .on('end', () => {
        console.log(`[VideoProcessor] Thumbnail generated for ${materialId}`);
      })
      .on('error', (err) => {
        console.error('[VideoProcessor] Thumbnail error:', err);
      });

    // Process video to HLS
    ffmpeg(inputPath)
      .outputOptions([
        // HLS settings
        '-hls_time 6',                    // 6 second segments
        '-hls_list_size 0',               // Keep all segments in playlist
        '-hls_segment_filename', path.join(outputDir, 'segment_%03d.ts'),
        
        // Video encoding
        '-c:v libx264',                   // H.264 codec
        '-preset fast',                   // Encoding speed
        '-crf 22',                        // Quality (lower = better, 18-28 range)
        
        // Audio encoding
        '-c:a aac',                       // AAC audio
        '-b:a 128k',                      // Audio bitrate
        '-ac 2',                          // Stereo
        
        // Optimization
        '-movflags +faststart',           // Enable streaming
        '-pix_fmt yuv420p',               // Compatibility
        '-profile:v baseline',            // H.264 profile
        '-level 3.0',                     // H.264 level
        
        // Multiple quality variants
        '-b:v:0 800k',  '-maxrate:v:0 856k',  '-bufsize:v:0 1200k', // 480p
        '-b:v:1 1400k', '-maxrate:v:1 1498k', '-bufsize:v:1 2100k', // 720p
        '-b:v:2 2800k', '-maxrate:v:2 2996k', '-bufsize:v:2 4200k', // 1080p
        
        // Adaptive streaming
        '-var_stream_map', 'v:0,a:0 v:1,a:0 v:2,a:0',
        '-master_pl_name', 'playlist.m3u8'
      ])
      .output(path.join(outputDir, 'stream_%v.m3u8'))
      .on('start', (cmd) => {
        console.log(`[VideoProcessor] Starting: ${materialId}`);
        console.log(`[VideoProcessor] Command: ${cmd}`);
      })
      .on('progress', (progress) => {
        if (progress.percent) {
          console.log(`[VideoProcessor] ${materialId}: ${Math.round(progress.percent)}%`);
        }
      })
      .on('end', async () => {
        console.log(`[VideoProcessor] ✅ Completed: ${materialId}`);
        
        // Get video metadata
        const metadata = await getVideoMetadata(inputPath);
        
        resolve({
          success: true,
          streamUrl: `/streams/${materialId}/playlist.m3u8`,
          thumbnailUrl: `/streams/${materialId}/thumbnail.jpg`,
          duration: metadata.duration
        });
      })
      .on('error', (err) => {
        console.error(`[VideoProcessor] ❌ Error: ${materialId}`, err);
        reject(err);
      })
      .run();
  });
}

/**
 * Get video metadata (duration, resolution, etc.)
 */
export function getVideoMetadata(videoPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(videoPath, (err, metadata) => {
      if (err) return reject(err);
      
      const videoStream = metadata.streams.find(s => s.codec_type === 'video');
      const duration = metadata.format.duration;
      
      resolve({
        duration: Math.round(duration),
        width: videoStream?.width || 0,
        height: videoStream?.height || 0,
        bitrate: metadata.format.bit_rate,
        codec: videoStream?.codec_name
      });
    });
  });
}

/**
 * Delete processed video files
 */
export async function deleteProcessedVideo(materialId) {
  const outputDir = path.join(process.cwd(), "public", "streams", String(materialId));
  
  try {
    await fs.rm(outputDir, { recursive: true, force: true });
    console.log(`[VideoProcessor] Deleted: ${materialId}`);
  } catch (err) {
    console.error(`[VideoProcessor] Delete error: ${materialId}`, err);
  }
}