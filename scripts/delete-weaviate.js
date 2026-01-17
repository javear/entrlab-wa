#!/usr/bin/env node

/**
 * Delete Conversations and ChatEvents from Weaviate
 * 
 * Delete conversations and their associated chat events from Weaviate
 * 
 * Usage (single conversation):
 *   node scripts/delete-weaviate.js --tenant <agent_code> --conversation <conversation_id> [options]
 * 
 * Usage (all conversations in tenant):
 *   node scripts/delete-weaviate.js --tenant <agent_code> --all [options]
 * 
 * Options:
 *   --tenant <agent_code>        Tenant (agent_code) [required]
 *   --conversation <id>          Conversation ID to delete (required if not using --all)
 *   --all                        Delete ALL conversations in the tenant [required if not using --conversation]
 *   --include-events             Also delete all ChatEvents associated with conversations (default: true)
 *   --no-events                  Only delete Conversations, keep ChatEvents
 *   --dry-run                    Show what would be deleted without actually deleting
 *   --force                      Skip confirmation prompt
 */

require('dotenv').config();

// Try to load weaviate-ts-client from multiple possible locations
let weaviateModule;
try {
  // Try root node_modules first
  weaviateModule = require('weaviate-ts-client');
} catch (e) {
  try {
    // Try pubsub service node_modules
    weaviateModule = require('../services/pubsub/node_modules/weaviate-ts-client');
  } catch (e2) {
    console.error('❌ Error: weaviate-ts-client not found');
    console.error('   Please run: cd services/pubsub && npm install');
    process.exit(1);
  }
}

const weaviate = weaviateModule.default || weaviateModule;
const readline = require('readline');

// Parse command line arguments
const args = process.argv.slice(2);
const getArg = (name, defaultValue = null) => {
  const index = args.indexOf(name);
  return index !== -1 && args[index + 1] ? args[index + 1] : defaultValue;
};
const hasFlag = (name) => args.includes(name);

const tenant = getArg('--tenant');
const conversationId = getArg('--conversation');
const deleteAll = hasFlag('--all');
const includeEvents = hasFlag('--include-events') || !hasFlag('--no-events'); // Default to true
const dryRun = hasFlag('--dry-run');
const force = hasFlag('--force');

if (!tenant) {
  console.error('❌ Error: --tenant is required');
  console.log('\nUsage:');
  console.log('  # Delete single conversation:');
  console.log('  node scripts/delete-weaviate.js --tenant <agent_code> --conversation <conversation_id> [options]');
  console.log('\n  # Delete all conversations in tenant:');
  console.log('  node scripts/delete-weaviate.js --tenant <agent_code> --all [options]');
  console.log('\nOptions:');
  console.log('  --tenant <agent_code>        Tenant (agent_code) [required]');
  console.log('  --conversation <id>          Conversation ID to delete (required if not using --all)');
  console.log('  --all                        Delete ALL conversations in the tenant');
  console.log('  --include-events             Also delete all ChatEvents (default: true)');
  console.log('  --no-events                  Only delete Conversations, keep ChatEvents');
  console.log('  --dry-run                    Show what would be deleted without actually deleting');
  console.log('  --force                      Skip confirmation prompt');
  process.exit(1);
}

if (!deleteAll && !conversationId) {
  console.error('❌ Error: Either --conversation or --all must be specified');
  process.exit(1);
}

if (deleteAll && conversationId) {
  console.error('❌ Error: Cannot use both --conversation and --all. Use one or the other.');
  process.exit(1);
}

// Initialize Weaviate client
function initializeClient() {
  const weaviateUrl = process.env.WEAVIATE_URL || 'http://localhost:8080';
  
  // Parse URL
  let scheme = 'http';
  let host = '';
  let port = 8080;

  if (weaviateUrl.startsWith('http://') || weaviateUrl.startsWith('https://')) {
    const url = new URL(weaviateUrl);
    scheme = url.protocol === 'https:' ? 'https' : 'http';
    host = url.hostname;
    port = url.port ? parseInt(url.port) : (scheme === 'https' ? 443 : 8080);
  } else {
    const parts = weaviateUrl.split(':');
    host = parts[0];
    if (parts.length > 1) {
      port = parseInt(parts[1]) || 8080;
    } else {
      if (weaviateUrl.includes('railway') || weaviateUrl.includes('.up.') || weaviateUrl.includes('.app')) {
        scheme = 'https';
        port = 443;
      }
    }
  }

  const clientConfig = {
    scheme,
    host,
  };

  if ((scheme === 'http' && port !== 8080) || (scheme === 'https' && port !== 443)) {
    clientConfig.port = port;
  }

  if (process.env.WEAVIATE_API_KEY) {
    clientConfig.headers = {
      'Authorization': `Bearer ${process.env.WEAVIATE_API_KEY}`
    };
  }

  if (process.env.OPENAI_API_KEY) {
    if (!clientConfig.headers) clientConfig.headers = {};
    clientConfig.headers['X-OpenAI-Api-Key'] = process.env.OPENAI_API_KEY;
  }

  return weaviate.client(clientConfig);
}

// Prompt for confirmation
function promptConfirmation(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'yes' || answer.toLowerCase() === 'y');
    });
  });
}

// Get all conversations in tenant
async function getAllConversations(client, tenant) {
  const result = await client.graphql
    .get()
    .withClassName('Conversation')
    .withTenant(tenant)
    .withFields('conversation_id hashed_id participant_ids created_at last_event_at status metadata _additional { id }')
    .do();

  return result.data?.Get?.Conversation || [];
}

// Get conversation with UUID by conversation_id
async function getConversation(client, tenant, conversationId) {
  // Try by conversation_id first
  let result = await client.graphql
    .get()
    .withClassName('Conversation')
    .withTenant(tenant)
    .withFields('conversation_id hashed_id participant_ids created_at last_event_at status metadata _additional { id }')
    .withWhere({
      path: ['conversation_id'],
      operator: 'Equal',
      valueString: conversationId
    })
    .withLimit(1)
    .do();

  let conversations = result.data?.Get?.Conversation || [];
  if (conversations.length > 0) {
    return conversations[0];
  }

  // Try by hashed_id as fallback
  result = await client.graphql
    .get()
    .withClassName('Conversation')
    .withTenant(tenant)
    .withFields('conversation_id hashed_id participant_ids created_at last_event_at status metadata _additional { id }')
    .withWhere({
      path: ['hashed_id'],
      operator: 'Equal',
      valueString: conversationId
    })
    .withLimit(1)
    .do();

  conversations = result.data?.Get?.Conversation || [];
  if (conversations.length > 0) {
    return conversations[0];
  }

  // Try by _id (UUID) as fallback
  const allConversations = await getAllConversations(client, tenant);
  const found = allConversations.find(conv => conv._additional?.id === conversationId);
  return found || null;
}

// Get chat events for a conversation
async function getChatEvents(client, tenant, conversationId) {
  const result = await client.graphql
    .get()
    .withClassName('ChatEvent')
    .withTenant(tenant)
    .withFields('event_id event_type created_at _additional { id }')
    .withWhere({
      path: ['conversation_id'],
      operator: 'Equal',
      valueString: conversationId
    })
    .do();

  return result.data?.Get?.ChatEvent || [];
}

// Get all chat events for a tenant
async function getAllChatEvents(client, tenant) {
  const result = await client.graphql
    .get()
    .withClassName('ChatEvent')
    .withTenant(tenant)
    .withFields('event_id conversation_id event_type created_at _additional { id }')
    .do();

  return result.data?.Get?.ChatEvent || [];
}

// Delete conversation by UUID
async function deleteConversation(client, tenant, conversationUuid) {
  await client.data
    .deleter()
    .withId(conversationUuid)
    .withClassName('Conversation')
    .withTenant(tenant)
    .do();
}

// Delete chat event by UUID
async function deleteChatEvent(client, tenant, eventUuid) {
  await client.data
    .deleter()
    .withId(eventUuid)
    .withClassName('ChatEvent')
    .withTenant(tenant)
    .do();
}

// Main function
async function main() {
  try {
    console.log('🔍 Connecting to Weaviate...');
    const client = initializeClient();

    // Test connection
    await client.misc.metaGetter().do();
    console.log('✅ Connected to Weaviate\n');

    if (deleteAll) {
      // Delete all conversations in tenant
      console.log(`📚 Looking up all conversations in tenant: ${tenant}`);
      const conversations = await getAllConversations(client, tenant);
      
      if (conversations.length === 0) {
        console.log(`⚠️  No conversations found in tenant: ${tenant}`);
        process.exit(0);
      }

      console.log(`✅ Found ${conversations.length} conversation(s)\n`);

      // Get all events if needed
      let allEvents = [];
      if (includeEvents) {
        console.log(`🔍 Looking up all ChatEvents in tenant...`);
        allEvents = await getAllChatEvents(client, tenant);
        console.log(`✅ Found ${allEvents.length} ChatEvent(s)\n`);
      }

      // Show what will be deleted
      console.log('📋 Summary:');
      console.log(`   Will delete: ${conversations.length} Conversation(s)`);
      if (includeEvents) {
        console.log(`   Will delete: ${allEvents.length} ChatEvent(s)`);
      }
      console.log('');

      if (dryRun) {
        console.log('🔍 DRY RUN MODE - No deletions will be performed\n');
        console.log('Would delete:');
        conversations.forEach((conv, index) => {
          console.log(`  ${index + 1}. Conversation: ${conv.conversation_id} (UUID: ${conv._additional.id})`);
        });
        if (includeEvents && allEvents.length > 0) {
          console.log(`\n  ChatEvents: ${allEvents.length} total events`);
        }
        process.exit(0);
      }

      // Confirm deletion
      if (!force) {
        console.log('⚠️  WARNING: This will delete ALL conversations and events in this tenant!');
        console.log(`⚠️  This action cannot be undone!`);
        const confirmed = await promptConfirmation(`Are you sure you want to delete ${conversations.length} conversation(s)? (yes/no): `);
        
        if (!confirmed) {
          console.log('❌ Deletion cancelled');
          process.exit(0);
        }
        console.log('');
      }

      // Delete all events first (if included)
      if (includeEvents && allEvents.length > 0) {
        console.log(`🗑️  Deleting ${allEvents.length} ChatEvent(s)...`);
        for (let i = 0; i < allEvents.length; i++) {
          const event = allEvents[i];
          try {
            await deleteChatEvent(client, tenant, event._additional.id);
            if ((i + 1) % 10 === 0 || i === allEvents.length - 1) {
              console.log(`   Progress: ${i + 1}/${allEvents.length} events deleted`);
            }
          } catch (error) {
            console.error(`   ❌ Failed to delete ChatEvent ${event.event_id}:`, error.message);
          }
        }
        console.log(`✅ Deleted ${allEvents.length} ChatEvent(s)\n`);
      }

      // Delete all conversations
      console.log(`🗑️  Deleting ${conversations.length} Conversation(s)...`);
      let deletedCount = 0;
      for (let i = 0; i < conversations.length; i++) {
        const conversation = conversations[i];
        try {
          await deleteConversation(client, tenant, conversation._additional.id);
          deletedCount++;
          if ((i + 1) % 10 === 0 || i === conversations.length - 1) {
            console.log(`   Progress: ${i + 1}/${conversations.length} conversations deleted`);
          }
        } catch (error) {
          console.error(`   ❌ Failed to delete conversation ${conversation.conversation_id}:`, error.message);
        }
      }
      console.log('');
      console.log(`✅ Successfully deleted ${deletedCount}/${conversations.length} conversation(s)`);
      console.log('✨ Deletion complete!');

    } else {
      // Delete single conversation
      console.log(`📚 Looking up conversation: ${conversationId}`);
      const conversation = await getConversation(client, tenant, conversationId);

      if (!conversation) {
        console.log(`⚠️  Conversation not found: ${conversationId}`);
        console.log(`   Tenant: ${tenant}`);
        console.log(`   Tried: conversation_id, hashed_id, and _id`);
        process.exit(1);
      }

      console.log(`✅ Found conversation:`);
      console.log(`   ID: ${conversation.conversation_id}`);
      console.log(`   Hashed ID: ${conversation.hashed_id || 'N/A'}`);
      console.log(`   Participants: ${(conversation.participant_ids || []).join(', ')}`);
      console.log(`   Created: ${conversation.created_at}`);
      console.log(`   Last Event: ${conversation.last_event_at}`);
      console.log(`   Status: ${conversation.status}`);
      console.log('');

      // Get associated events if needed
      let events = [];
      if (includeEvents) {
        console.log(`🔍 Looking up associated ChatEvents...`);
        events = await getChatEvents(client, tenant, conversation.conversation_id);
        console.log(`✅ Found ${events.length} ChatEvent(s)\n`);
      }

      // Show what will be deleted
      console.log('📋 Summary:');
      console.log(`   Will delete: 1 Conversation`);
      if (includeEvents) {
        console.log(`   Will delete: ${events.length} ChatEvent(s)`);
      }
      console.log('');

      if (dryRun) {
        console.log('🔍 DRY RUN MODE - No deletions will be performed\n');
        console.log('Would delete:');
        console.log(`  - Conversation: ${conversation.conversation_id} (UUID: ${conversation._additional.id})`);
        if (includeEvents && events.length > 0) {
          console.log(`  - ChatEvents:`);
          events.forEach((event, index) => {
            console.log(`    ${index + 1}. ${event.event_id} (${event.event_type}) - UUID: ${event._additional.id}`);
          });
        }
        process.exit(0);
      }

      // Confirm deletion
      if (!force) {
        console.log('⚠️  WARNING: This action cannot be undone!');
        const confirmed = await promptConfirmation('Are you sure you want to delete this conversation? (yes/no): ');
        
        if (!confirmed) {
          console.log('❌ Deletion cancelled');
          process.exit(0);
        }
        console.log('');
      }

      // Delete events first (if included)
      if (includeEvents && events.length > 0) {
        console.log(`🗑️  Deleting ${events.length} ChatEvent(s)...`);
        for (let i = 0; i < events.length; i++) {
          const event = events[i];
          try {
            await deleteChatEvent(client, tenant, event._additional.id);
            console.log(`   ✅ Deleted ChatEvent ${i + 1}/${events.length}: ${event.event_id}`);
          } catch (error) {
            console.error(`   ❌ Failed to delete ChatEvent ${event.event_id}:`, error.message);
          }
        }
        console.log('');
      }

      // Delete conversation
      console.log(`🗑️  Deleting Conversation...`);
      try {
        await deleteConversation(client, tenant, conversation._additional.id);
        console.log(`✅ Successfully deleted conversation: ${conversationId}`);
        console.log('');
        console.log('✨ Deletion complete!');
      } catch (error) {
        console.error(`❌ Failed to delete conversation:`, error.message);
        process.exit(1);
      }
    }

  } catch (error) {
    console.error('❌ Error:', error.message);
    if (error.response) {
      console.error('Response:', JSON.stringify(error.response, null, 2));
    }
    process.exit(1);
  }
}

main();


