// ============================================
// Memory Monitor Service
// Monitors memory usage and triggers warnings/cleanup
// ============================================

import { MEMORY_CONFIG, getMemoryUsage, isMemoryCritical, needsMemoryWarning, suggestGC } from '../config/memory-config';

export class MemoryMonitorService {
  private monitorInterval: NodeJS.Timeout | null = null;
  private lastWarningTime: number = 0;
  private readonly WARNING_COOLDOWN = 300000; // 5 minutes between warnings

  /**
   * Start monitoring memory usage
   */
  public start(intervalMs: number = 60000): void {
    if (this.monitorInterval) {
      console.log('⚠️  Memory monitor already running');
      return;
    }

    console.log('🔍 Starting memory monitor...');
    
    // Initial memory check
    this.checkMemory();

    // Periodic monitoring
    this.monitorInterval = setInterval(() => {
      this.checkMemory();
    }, intervalMs);
  }

  /**
   * Check current memory usage
   */
  private checkMemory(): void {
    const memUsage = getMemoryUsage();
    
    // Critical memory usage
    if (isMemoryCritical()) {
      const now = Date.now();
      if (now - this.lastWarningTime > this.WARNING_COOLDOWN) {
        console.error(`🚨 CRITICAL MEMORY USAGE: ${memUsage.heapUsedMB}MB / ${memUsage.heapTotalMB}MB (${memUsage.heapUsagePercent}%)`);
        console.error(`🚨 Consider: 1) Reducing active clients 2) Increasing heap size 3) Checking for memory leaks`);
        this.lastWarningTime = now;
      }
      
      // Force garbage collection
      suggestGC();
    }
    // Warning level
    else if (needsMemoryWarning()) {
      const now = Date.now();
      if (now - this.lastWarningTime > this.WARNING_COOLDOWN) {
        console.warn(`⚠️  High memory usage: ${memUsage.heapUsedMB}MB / ${memUsage.heapTotalMB}MB (${memUsage.heapUsagePercent}%)`);
        this.lastWarningTime = now;
      }
    }
  }

  /**
   * Get current memory statistics
   */
  public getStats(): {
    heapUsedMB: number;
    heapTotalMB: number;
    heapUsagePercent: number;
    rss: number;
    external: number;
  } {
    return getMemoryUsage();
  }

  /**
   * Stop monitoring
   */
  public stop(): void {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
      console.log('🔍 Memory monitor stopped');
    }
  }

  /**
   * Force garbage collection
   */
  public forceGC(): void {
    suggestGC();
    console.log('🗑️  Garbage collection suggested');
  }
}

