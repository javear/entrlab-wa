# Memory Usage Optimization Guide

## Problem
- Memory usage at 99% (296MB / 299MB)
- Very small heap size (299MB) for Node.js + Puppeteer
- Risk of out-of-memory crashes

## Root Causes

1. **Small Heap Size (299MB)** - Primary issue
   - Node.js default heap is too small for Puppeteer
   - Each Puppeteer instance uses ~30-50MB
   - Media processing needs buffer space

2. **Message Queues**
   - Currently: 30 messages per user, 2 min age
   - Can accumulate during high traffic

3. **Temp Files**
   - Cleaned every 5 minutes
   - Can accumulate during media processing

4. **Media Processing**
   - Images/videos loaded into memory
   - Base64 encoding increases size

## Solutions Implemented

### 1. ✅ Optimized Memory Config
- Reduced queue size: 30 → 20 messages
- Reduced queue age: 2 min → 1.5 min
- Faster temp cleanup: 5 min → 3 min
- Shorter temp file age: 10 min → 5 min

### 2. ✅ Aggressive GC Hints
- GC after processing large message batches
- GC after temp file cleanup
- GC after queue cleanup

### 3. ⚠️ **REQUIRED: Increase Heap Size**

**This is the most important fix!** Your heap is only 299MB, which is too small.

#### Option A: Environment Variable (Recommended)
Add to your `.env` or Railway environment:
```bash
NODE_OPTIONS="--max-old-space-size=512"
```

**Important**: 
- `--expose-gc` is **NOT allowed** in NODE_OPTIONS on Railway/cloud platforms
- The code automatically handles this - if `global.gc` is unavailable, it's safely skipped
- Node.js will still perform automatic garbage collection
- Manual GC hints (`suggestGC()`) will work if available, otherwise silently ignored

#### Option B: Update package.json start script (Already Done)
```json
{
  "scripts": {
    "start": "node --max-old-space-size=512 dist/index.js"
  }
}
```

#### Option C: Railway/Docker
In your Railway service or Dockerfile:
```bash
NODE_OPTIONS="--max-old-space-size=512" npm start
```

### Recommended Heap Sizes
- **Minimum**: 512MB (for 1-5 clients)
- **Recommended**: 768MB (for 5-10 clients)
- **Production**: 1024MB (for 10+ clients)

## Expected Results

After applying heap size fix:
- Memory usage: 99% → ~60-70%
- More headroom for media processing
- Reduced risk of OOM crashes
- Better performance

## Monitoring

Check memory status:
```bash
curl http://localhost:3003/memory/status
```

Watch for:
- Heap usage should stay below 80% normally
- Warnings at 80%
- Critical at 90%

## Additional Optimizations (Already Applied)

1. ✅ More frequent queue cleanup (1.5 min vs 2 min)
2. ✅ Smaller queue size (20 vs 30 messages)
3. ✅ Faster temp file cleanup (3 min vs 5 min)
4. ✅ Aggressive GC hints after cleanup operations

These optimizations are safe and won't break functionality - they just clean up faster.

