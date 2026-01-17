# Redis Streams Consumer Best Practices

This document outlines the best practices for consuming messages from Redis Streams using consumer groups. All consumers in this repository follow these standards.

## Core Principles

1. **No Message Loss**: Pending messages (read but not ACKed) are retried before processing new messages
2. **No Duplicate Processing**: Only process messages that haven't been delivered to the consumer group
3. **Graceful Failure Handling**: Failed messages remain pending and can be retried
4. **Position Tracking**: Consumer groups track their position via `lastDeliveredId`

## Standard Reading Pattern

All consumers use the same two-step reading pattern implemented in `stream.service.js`:

### Step 1: Read Pending Messages First (id: '0')
- **Purpose**: Retry messages that were read but not ACKed
- **When**: Always check for pending messages first
- **Why**: Ensures no message loss if a consumer crashed or failed to ACK
- **Behavior**: Non-blocking (BLOCK: 0)

### Step 2: Read New Messages (id: '>')
- **Purpose**: Read messages published after the group's `lastDeliveredId`
- **When**: Only if no pending messages
- **Why**: Ensures we only process messages we haven't seen yet
- **Behavior**: Blocking (uses provided block time)

## Consumer Group Creation

### Default: Start from New Messages Only (`'$'`)

**All consumers default to `startId = '$'`**, which means:
- New consumer groups only read messages published **after** the group was created
- Existing consumer groups use their current position (`lastDeliveredId`)
- No processing of historical messages (unless explicitly needed)

### When to Use `startId = '0'`

Only use `startId = '0'` if you explicitly need to process historical messages:
- Initial data migration
- Reprocessing all messages from the beginning
- Recovery from a specific point in time

**Warning**: Using `'0'` will process ALL messages in the stream, which can be:
- Very slow for large streams
- Cause duplicate processing if messages were already handled
- Overwhelm downstream systems

### Environment Variables

Each consumer supports environment variables to override defaults:

**Consumer Group Names** (for prod/dev separation):
- `WEAVIATE_CONSUMER_GROUP` - Weaviate consumer group (default: `'weaviate-consumer'`)
- `WPP_OUTGOING_CONSUMER_GROUP` - WPP outgoing message consumer group (default: `'outgoing-message-consumer-wpp'`)
- `WA_OFFICIAL_OUTGOING_CONSUMER_GROUP` - WA-Official outgoing message consumer group (default: `'outgoing-message-consumer-wa-official'`)
- `OUTGOING_MESSAGE_CONSUMER_GROUP` - Legacy/fallback (deprecated, use platform-specific vars above)
- `WEBHOOK_CONSUMER_GROUP` - Webhook consumer group (default: `'webhook-delivery'`)

**Start ID** (for historical message processing):
- `WEAVIATE_CONSUMER_START_ID` - Weaviate consumer (default: `'$'`)
- `OUTGOING_MESSAGE_CONSUMER_START_ID` - Outgoing message consumers (default: `'$'`)
- `WEBHOOK_CONSUMER_START_ID` - Webhook consumer (default: `'$'`)

**Consumer Names** (for identifying individual consumers):
- `WEAVIATE_CONSUMER_NAME` - Weaviate consumer name (default: auto-generated)
- `OUTGOING_MESSAGE_CONSUMER_NAME` - Outgoing message consumer name (default: auto-generated)
- `WEBHOOK_CONSUMER_NAME` - Webhook consumer name (default: auto-generated)

## ACK Strategy

### Always ACK After Successful Processing

- **ACK immediately** after successfully processing a message
- This advances the consumer group's `lastDeliveredId`
- Prevents the same message from being read again

### Don't ACK on Failure

- **Don't ACK** if processing fails
- Failed messages remain in the pending list
- They will be retried on the next read cycle

### Idempotency

- All consumers should handle duplicate messages gracefully
- Use message IDs or event IDs to detect duplicates
- Skip processing if a message was already handled

## Consumer Group Position Management

### For New Consumer Groups

1. Create with `startId = '$'` (default)
2. Group will only read new messages going forward
3. Position tracked via `lastDeliveredId`

### For Existing Consumer Groups

1. Group uses its current `lastDeliveredId`
2. `readGroup` reads pending messages first, then new messages with `'>'`
3. Position advances automatically as messages are ACKed

### Resetting Consumer Group Position

If you need to reset a consumer group position:

```bash
# Reset to current end of stream (only new messages)
npm run reset-weaviate-consumer-position

# Or manually using Redis CLI
XGROUP SETID <stream> <group> $
```

## Implementation Checklist

When creating a new consumer, ensure:

- [ ] Uses `startId = '$'` as default (or via env var)
- [ ] Uses `streamService.readGroup()` (handles pending + new messages)
- [ ] ACKs messages only after successful processing
- [ ] Handles failures gracefully (don't ACK on failure)
- [ ] Implements idempotency checks
- [ ] Logs consumer group status on startup
- [ ] Follows the standard two-step reading pattern

## Example Consumer Pattern

```javascript
async ensureConsumerGroup() {
  // Best Practice: Use '$' to start from new messages only
  const startId = process.env.MY_CONSUMER_START_ID || '$';
  
  try {
    await this.streamService.createConsumerGroup(this.consumerGroupName, startId);
    console.log(`✅ Created consumer group: ${this.consumerGroupName} (startId: ${startId === '$' ? 'new messages only' : 'from beginning'})`);
  } catch (error) {
    if (error.message && error.message.includes('BUSYGROUP')) {
      console.log(`ℹ️  Consumer group ${this.consumerGroupName} already exists`);
      // Group will use its current position
    } else {
      throw error;
    }
  }
}

async consumeLoop() {
  while (this.isRunning) {
    // readGroup handles: pending first (id: '0'), then new (id: '>')
    const entries = await this.streamService.readGroup(
      this.consumerGroupName,
      this.consumerName,
      { count: 10, block: 5000 }
    );

    for (const entry of entries) {
      try {
        // Process message
        await this.processMessage(entry.data);
        
        // ACK only after successful processing
        await this.streamService.acknowledge(
          this.consumerGroupName,
          entry.id
        );
      } catch (error) {
        // Don't ACK on failure - message will be retried
        console.error('Error processing message:', error);
      }
    }
  }
}
```

## Benefits

Following these best practices ensures:

1. **No Message Loss**: Pending messages are always retried
2. **No Duplicate Processing**: Only new messages are processed
3. **Efficient Processing**: No unnecessary reprocessing of historical messages
4. **Graceful Recovery**: Failed messages are automatically retried
5. **Consistent Behavior**: All consumers follow the same pattern
6. **Easy Debugging**: Clear logging of consumer group status

## Production vs Development Separation

### ⚠️ CRITICAL: Use Different Consumer Groups for Prod and Dev

**If prod and dev use the SAME consumer group name, they WILL compete for messages!**

Each consumer group has ONE position (`lastDeliveredId`). If prod and dev share the same group:
- They compete for the same messages
- One environment may consume messages intended for the other
- Message processing becomes unpredictable

### Recommended Configuration

**Production Environment:**
```bash
WEAVIATE_CONSUMER_GROUP=weaviate-consumer-prod
WPP_OUTGOING_CONSUMER_GROUP=outgoing-message-consumer-wpp-prod
WA_OFFICIAL_OUTGOING_CONSUMER_GROUP=outgoing-message-consumer-wa-official-prod
WEBHOOK_CONSUMER_GROUP=webhook-delivery-prod
```

**Development Environment:**
```bash
WEAVIATE_CONSUMER_GROUP=weaviate-consumer-dev
WPP_OUTGOING_CONSUMER_GROUP=outgoing-message-consumer-wpp-dev
WA_OFFICIAL_OUTGOING_CONSUMER_GROUP=outgoing-message-consumer-wa-official-dev
WEBHOOK_CONSUMER_GROUP=webhook-delivery-dev
```

### Benefits of Separate Consumer Groups

1. **No Competition**: Prod and dev don't interfere with each other
2. **Independent Processing**: Each environment processes messages independently
3. **Safe Testing**: Dev can test without affecting prod
4. **Clear Separation**: Easy to identify which environment processed which messages

### Shared Stream, Separate Groups

- **Same Stream**: Both prod and dev read from the same Redis stream
- **Different Groups**: Each environment has its own consumer group
- **Independent Positions**: Each group tracks its own `lastDeliveredId`
- **No Interference**: Messages processed by one group don't affect the other

## Troubleshooting

### Consumer Not Reading Messages

1. Check consumer group exists: `XINFO GROUPS <stream>`
2. Check `lastDeliveredId`: Should advance as messages are ACKed
3. Check pending count: Should be 0 if all messages are processed
4. Verify consumer is using `readGroup()` (not direct stream read)
5. **Verify consumer group name matches environment** (prod vs dev)

### Messages Stuck in Pending

1. Check if consumer is ACKing messages
2. Verify processing logic doesn't throw unhandled errors
3. Check consumer is actually running and connected
4. Consider claiming pending messages for another consumer

### Processing Historical Messages

1. Set `*_CONSUMER_START_ID='0'` before first run
2. Or reset consumer group position: `XGROUP SETID <stream> <group> 0`
3. **Warning**: This will process ALL messages in the stream

### Prod/Dev Competition Issues

If you see messages being consumed by the wrong environment:
1. Check consumer group names: `XINFO GROUPS <stream>`
2. Verify environment variables are set correctly
3. Ensure prod and dev use different consumer group names
4. Restart consumers after changing consumer group names

## References

- [Redis Streams Documentation](https://redis.io/docs/data-types/streams/)
- [Consumer Groups Guide](https://redis.io/docs/data-types/streams/#consumer-groups)
- `services/pubsub/services/stream.service.js` - Standard implementation
