// Script to reset the Weaviate consumer group position to current end of stream
// This makes it only read NEW messages going forward, not historical ones

// Load environment variables
require('dotenv').config();

const redis = require('redis');

async function resetConsumerGroupPosition() {
  // Use the same connection logic as stream.service.js
  const hostOrUrl = process.env.VALKEY_HOST || process.env.REDIS_HOST || 'localhost';
  const isUrl = hostOrUrl.startsWith('redis://') || hostOrUrl.startsWith('rediss://');
  
  let connectionOptions;
  if (isUrl) {
    connectionOptions = {
      url: hostOrUrl,
      socket: {
        reconnectStrategy: (retries) => {
          if (retries > 3) {
            return new Error('Max reconnection attempts reached');
          }
          return Math.min(retries * 100, 1000);
        }
      }
    };
  } else {
    connectionOptions = {
      socket: {
        host: hostOrUrl,
        port: parseInt(process.env.VALKEY_PORT || process.env.REDIS_PORT || '6379'),
        reconnectStrategy: (retries) => {
          if (retries > 3) {
            return new Error('Max reconnection attempts reached');
          }
          return Math.min(retries * 100, 1000);
        }
      },
      password: process.env.VALKEY_PASSWORD || process.env.REDIS_PASSWORD || null,
      database: parseInt(process.env.VALKEY_DB || process.env.REDIS_DB || '0'),
    };
  }
  
  const client = redis.createClient(connectionOptions);

  await client.connect();
  console.log('✅ Connected to Redis/Valkey');

  const streamName = process.env.VALKEY_STREAM_NAME || 'platform-message:events';
  const consumerGroupName = process.env.WEAVIATE_CONSUMER_GROUP || 'weaviate-consumer';

  console.log(`📋 Configuration:`);
  console.log(`   Stream: ${streamName}`);
  console.log(`   Consumer Group: ${consumerGroupName}`);
  console.log(`   Redis Host: ${hostOrUrl}`);
  console.log('');

  try {
    // Check if stream exists
    const streamLength = await client.xLen(streamName);
    console.log(`ℹ️  Stream ${streamName} has ${streamLength} total message(s)`);

    // Get the last message ID in the stream (current end)
    let lastMessageId = '0-0';
    if (streamLength > 0) {
      // Get the last message
      const lastMessages = await client.xRevRange(streamName, '+', '-', { COUNT: 1 });
      if (lastMessages && lastMessages.length > 0) {
        lastMessageId = lastMessages[0].id;
        console.log(`ℹ️  Last message ID in stream: ${lastMessageId}`);
      }
    }

    // Check if consumer group exists
    let groupExists = false;
    try {
      const groups = await client.xInfoGroups(streamName);
      const existingGroup = groups.find(g => g.name === consumerGroupName);
      if (existingGroup) {
        groupExists = true;
        console.log(`ℹ️  Consumer group ${consumerGroupName} exists:`);
        console.log(`   Current lastDeliveredId: ${existingGroup.lastDeliveredId}`);
        console.log(`   Pending: ${existingGroup.pending}`);
        console.log(`   Consumers: ${existingGroup.consumers}`);
      }
    } catch (error) {
      if (error.message && (error.message.includes('no such key') || error.message.includes('not found'))) {
        console.log(`⚠️  Stream ${streamName} does not exist yet`);
      } else {
        throw error;
      }
    }

    if (!groupExists) {
      console.log(`⚠️  Consumer group ${consumerGroupName} does not exist`);
      console.log(`   It will be created with startId = '$' on next consumer startup`);
      await client.quit();
      return;
    }

    // Reset consumer group position to '$' (current end of stream)
    // This makes it only read NEW messages going forward
    try {
      await client.xGroupSetId(streamName, consumerGroupName, '$');
      console.log(`✅ Reset consumer group ${consumerGroupName} position to '$' (current end of stream)`);
      console.log(`   It will now only read NEW messages going forward`);
      
      // Verify the change
      const groups = await client.xInfoGroups(streamName);
      const updatedGroup = groups.find(g => g.name === consumerGroupName);
      if (updatedGroup) {
        console.log(`   New lastDeliveredId: ${updatedGroup.lastDeliveredId}`);
      }
    } catch (error) {
      console.error(`❌ Error resetting consumer group position:`, error.message);
      throw error;
    }

  } catch (error) {
    console.error('❌ Error:', error);
    throw error;
  }

  await client.quit();
  console.log('✅ Done! Consumer group position reset. Restart your consumer to start reading only new messages.');
}

resetConsumerGroupPosition().catch(error => {
  console.error('❌ Error:', error);
  process.exit(1);
});
