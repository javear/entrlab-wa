// ============================================
// Memory Optimization Configuration
// ============================================

export const MEMORY_CONFIG = {
  // Message queue limits (optimized for lower memory)
  MAX_QUEUE_SIZE: 20, // Max messages per user in queue (reduced from 30)
  MAX_QUEUE_AGE: 90000, // 1.5 minutes max message age (reduced from 2 min)
  QUEUE_CLEANUP_INTERVAL: 90000, // Clean queue every 1.5 minutes (reduced from 2 min)
  
  // File handling (more aggressive cleanup)
  MAX_FILE_SIZE: 10 * 1024 * 1024, // 10MB max file size
  TEMP_FILE_CLEANUP_INTERVAL: 180000, // Clean temp files every 3 minutes (reduced from 5 min)
  TEMP_FILE_MAX_AGE: 300000, // 5 minutes max temp file age (reduced from 10 min)
  
  // Client management
  MAX_CLIENTS: 50, // Maximum number of concurrent clients
  CLIENT_INACTIVITY_TIMEOUT: 3600000, // 1 hour inactivity timeout
  
  // Session backup
  BACKUP_COMPRESSION_LEVEL: 6, // Balanced compression (0-9)
  BACKUP_CHUNK_SIZE: 64 * 1024, // 64KB chunks for streaming
  MAX_BACKUP_AGE: 7 * 24 * 60 * 60 * 1000, // Keep backups for 7 days
  
  // MongoDB
  MONGODB_POOL_SIZE: 10, // Connection pool size
  MONGODB_MAX_IDLE_TIME: 60000, // 1 minute idle timeout
  
  // Media processing
  IMAGE_MAX_DIMENSION: 1920, // Max image dimension for processing
  VIDEO_MAX_DURATION: 300, // 5 minutes max video duration
  
  // Garbage collection hints
  GC_AFTER_CLIENT_CLOSE: true,
  GC_AFTER_LARGE_OPERATION: true,
  
  // Memory limits
  HEAP_SIZE_WARNING: 0.8, // Warn at 80% heap usage
  HEAP_SIZE_CRITICAL: 0.9, // Critical at 90% heap usage
};

/**
 * Get memory usage statistics
 */
export function getMemoryUsage(): {
  heapUsed: number;
  heapTotal: number;
  heapUsedMB: number;
  heapTotalMB: number;
  heapUsagePercent: number;
  external: number;
  rss: number;
} {
  const usage = process.memoryUsage();
  return {
    heapUsed: usage.heapUsed,
    heapTotal: usage.heapTotal,
    heapUsedMB: Math.round(usage.heapUsed / 1024 / 1024),
    heapTotalMB: Math.round(usage.heapTotal / 1024 / 1024),
    heapUsagePercent: Math.round((usage.heapUsed / usage.heapTotal) * 100),
    external: usage.external,
    rss: usage.rss,
  };
}

/**
 * Check if memory usage is critical
 */
export function isMemoryCritical(): boolean {
  const usage = getMemoryUsage();
  return usage.heapUsagePercent >= MEMORY_CONFIG.HEAP_SIZE_CRITICAL * 100;
}

/**
 * Check if memory usage needs warning
 */
export function needsMemoryWarning(): boolean {
  const usage = getMemoryUsage();
  return usage.heapUsagePercent >= MEMORY_CONFIG.HEAP_SIZE_WARNING * 100;
}

/**
 * Suggest garbage collection if enabled
 */
export function suggestGC(): void {
  if (global.gc) {
    global.gc();
  }
}

