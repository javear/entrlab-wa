// Script to reset the outgoing message consumer group
// This will delete and recreate the consumer group to start reading from the beginning

// Load environment variables
require('dotenv').config();

const redis = require('redis');

async function resetConsumerGroup() {
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

  // Use the same stream name logic as the services
  const streamName = process.env.VALKEY_STREAM_NAME || 'whatsapp:events';
  // Reset both consumer groups (WPP and WA-Official)
  // Use platform-specific env vars, fallback to legacy var, then defaults
  const wppGroup = process.env.WPP_OUTGOING_CONSUMER_GROUP || process.env.OUTGOING_MESSAGE_CONSUMER_GROUP || 'outgoing-message-consumer-wpp';
  const waOfficialGroup = process.env.WA_OFFICIAL_OUTGOING_CONSUMER_GROUP || process.env.OUTGOING_MESSAGE_CONSUMER_GROUP || 'outgoing-message-consumer-wa-official';
  
  // If legacy var is set, use it for both (backward compatibility)
  // Otherwise use platform-specific groups
  const groupNames = process.env.OUTGOING_MESSAGE_CONSUMER_GROUP && !process.env.WPP_OUTGOING_CONSUMER_GROUP && !process.env.WA_OFFICIAL_OUTGOING_CONSUMER_GROUP
    ? [process.env.OUTGOING_MESSAGE_CONSUMER_GROUP]
    : [wppGroup, waOfficialGroup];
  
  console.log(`📋 Configuration:`);
  console.log(`   Stream: ${streamName}`);
  console.log(`   Consumer Groups: ${groupNames.join(', ')}`);
  console.log(`   Redis Host: ${hostOrUrl}`);
  console.log(`   Redis Port: ${connectionOptions.socket?.port || 'from URL'}`);
  console.log(`   Redis DB: ${connectionOptions.database || 'from URL'}`);
  console.log('');

  // Check if stream exists
  try {
    const streamInfo = await client.xInfoStream(streamName);
    console.log(`ℹ️  Stream ${streamName} exists with ${streamInfo.length} messages`);
  } catch (error) {
    if (error.message && (error.message.includes('no such key') || error.message.includes('not found'))) {
      console.log(`⚠️  Stream ${streamName} does not exist yet - it will be created with the consumer groups`);
    } else {
      throw error;
    }
  }

  // Process each consumer group
  for (const groupName of groupNames) {
    console.log(`\n📦 Processing consumer group: ${groupName}`);
    
    // Check if consumer group exists and get its info
    let groupExists = false;
    try {
      const groups = await client.xInfoGroups(streamName);
      const existingGroup = groups.find(g => g.name === groupName);
      if (existingGroup) {
        groupExists = true;
        console.log(`   ℹ️  Consumer group exists:`);
        console.log(`      lastDeliveredId: ${existingGroup.lastDeliveredId}`);
        console.log(`      pending: ${existingGroup.pending}`);
        console.log(`      consumers: ${existingGroup.consumers}`);
      }
    } catch (error) {
      // Stream or group doesn't exist, that's fine
    }

    if (groupExists) {
      // Reset the consumer group to start from the beginning (or from '0' to read all)
      try {
        // Use XGROUP SETID to reset the group's lastDeliveredId
        // Using '0' allows reading all messages from the beginning
        await client.xGroupSetId(streamName, groupName, '0');
        console.log(`   ✅ Reset consumer group to start from beginning (lastDeliveredId = 0)`);
      } catch (error) {
        console.error(`   ❌ Error resetting consumer group position:`, error.message);
        // Fallback: delete and recreate
        try {
          await client.xGroupDestroy(streamName, groupName);
          console.log(`   ✅ Deleted consumer group (will recreate)`);
          groupExists = false;
        } catch (destroyError) {
          throw destroyError;
        }
      }
    }

    // Create the consumer group if it doesn't exist
    if (!groupExists) {
      try {
        await client.xGroupCreate(streamName, groupName, '0', {
          MKSTREAM: true // Create stream if it doesn't exist
        });
        console.log(`   ✅ Created consumer group (starting from beginning)`);
      } catch (error) {
        if (error.message && error.message.includes('BUSYGROUP')) {
          console.log(`   ℹ️  Consumer group already exists`);
        } else {
          throw error;
        }
      }
    }
  }

  await client.quit();
  console.log('✅ Done! Consumer group reset. Restart your application to start consuming messages.');
}

resetConsumerGroup().catch(error => {
  console.error('❌ Error:', error);
  process.exit(1);
});
