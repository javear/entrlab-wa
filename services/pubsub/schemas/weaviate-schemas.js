/**
 * Weaviate Schema Definitions
 * 
 * Defines the Conversation and ChatEvent schemas for storing chat events
 * Multi-tenancy is enabled using agent_code as the tenant
 */

/**
 * Conversation Schema
 * 
 * multiTenancy: enabled
 * vectorizer: none
 * 
 * Fields:
 * - conversation_id (string, primary key)
 * - title (string, optional)
 * - participant_ids (string[])
 * - created_at (date)
 * - last_event_at (date)
 * - status (string, enum: open, closed)
 * - metadata (object, optional)
 */
const CONVERSATION_SCHEMA = {
  class: 'Conversation',
  description: 'Represents a conversation between participants',
  multiTenancyConfig: {
    enabled: true
  },
  vectorizer: 'none',
  properties: [
    {
      name: 'conversation_id',
      dataType: ['string'],
      description: 'Unique identifier for the conversation',
      indexFilterable: true
    },
    {
      name: 'hashed_id',
      dataType: ['string'],
      description: 'Hashed room ID for universal identification across services (agentCode:clientId:userIdentifier)',
      indexFilterable: true
    },
    {
      name: 'client_id',
      dataType: ['string'],
      description: 'Client identifier (e.g., "javear-client-wpp")',
      indexFilterable: true
    },
    {
      name: 'platform',
      dataType: ['string'],
      description: 'Platform type: "wpp" (WPPConnect) or "wa-official" (WhatsApp Official)',
      indexFilterable: true
    },
    {
      name: 'title',
      dataType: ['string'],
      description: 'Optional title for the conversation'
    },
    {
      name: 'participant_ids',
      dataType: ['string[]'],
      description: 'Array of participant identifiers',
      indexFilterable: true
    },
    {
      name: 'created_at',
      dataType: ['date'],
      description: 'When the conversation was created'
    },
    {
      name: 'last_event_at',
      dataType: ['date'],
      description: 'Timestamp of the last event in the conversation'
    },
    {
      name: 'last_event_id',
      dataType: ['string'],
      description: 'ID of the last event in the conversation'
    },
    {
      name: 'last_event_type',
      dataType: ['string'],
      description: 'Type of the last event (message:incoming, ai:response)',
      indexFilterable: true
    },
    {
      name: 'last_event_content',
      dataType: ['text'],
      description: 'Content of the last event (formatted message array as JSON string, e.g., [{"type":"text","text":"Hello"}])'
    },
    {
      name: 'last_sender_type',
      dataType: ['string'],
      description: 'Type of the last sender (user, ai:agent)',
      indexFilterable: true
    },
    {
      name: 'last_sender_id',
      dataType: ['string'],
      description: 'ID of the last sender'
    },
    {
      name: 'last_sender_display_name',
      dataType: ['string'],
      description: 'Display name of the last sender'
    },
    {
      name: 'status',
      dataType: ['string'],
      description: 'Conversation status: open or closed',
      indexFilterable: true
    },
    {
      name: 'metadata',
      dataType: ['text'],
      description: 'Additional metadata about the conversation (stored as JSON string for flexibility)'
      // Note: Using 'text' type instead of 'object' because:
      // 1. Weaviate 'object' type requires nested properties to be defined upfront
      // 2. Our metadata is completely flexible/arbitrary JSON structure
      // 3. 'text' type allows storing any JSON structure as a string
    }
  ]
};

/**
 * ChatEvent Schema
 * 
 * multiTenancy: enabled
 * vectorizer: text2vec-openai
 * 
 * Fields:
 * - conversation_id (string)
 * - event_id (string, unique within tenant)
 * - event_type (string)
 * - sender_type (string, enum: user, agent, system)
 * - sender_id (string)
 * - sender_display_name (string, optional)
 * - sender_role_label (string, optional)
 * - sender_avatar_url (string, optional)
 * - participant_ids (string[])
 * - payload (object)
 * - sequence (int)
 * - created_at (date)
 * - visibility (string, enum: visible, hidden, deleted)
 */
const CHATEVENT_SCHEMA = {
  class: 'ChatEvent',
  description: 'Represents a single chat event in a conversation',
  multiTenancyConfig: {
    enabled: true
  },
  vectorizer: 'text2vec-openai',
  properties: [
    {
      name: 'conversation_id',
      dataType: ['string'],
      description: 'The conversation this event belongs to',
      indexInverted: true
    },
    {
      name: 'event_id',
      dataType: ['string'],
      description: 'Unique identifier for this event',
      indexInverted: true
    },
    {
      name: 'event_type',
      dataType: ['string'],
      description: 'Type of event: message:incoming, ai:response, etc.',
      indexInverted: true
    },
    {
      name: 'sender_type',
      dataType: ['string'],
      description: 'Type of sender: user, agent, or system',
      indexInverted: true
    },
    {
      name: 'sender_id',
      dataType: ['string'],
      description: 'Identifier of the sender',
      indexInverted: true
    },
    {
      name: 'sender_display_name',
      dataType: ['string'],
      description: 'Display name of the sender',
      indexInverted: false
    },
    {
      name: 'sender_role_label',
      dataType: ['string'],
      description: 'Role label of the sender',
      indexInverted: false
    },
    {
      name: 'sender_avatar_url',
      dataType: ['string'],
      description: 'Avatar URL of the sender',
      indexInverted: false
    },
    {
      name: 'participant_ids',
      dataType: ['string[]'],
      description: 'All participants in this event',
      indexInverted: false
    },
    {
      name: 'content',
      dataType: ['text'],
      description: 'Formatted message content as JSON array (e.g., [{"type":"text","text":"Hello"}])',
      // Note: Using 'text' type to store JSON array of formatted messages
      // For ai:response: extracts from response.messages or response.formatted.whatsapp
      // For message:incoming: formats as [{"type":"text","text":"content"}]
      indexInverted: false
    },
    {
      name: 'sequence',
      dataType: ['int'],
      description: 'Sequence number of the event in the conversation',
      indexInverted: false
    },
    {
      name: 'created_at',
      dataType: ['date'],
      description: 'When this event was created',
      indexInverted: false
    },
    {
      name: 'visibility',
      dataType: ['string'],
      description: 'Visibility of the event: visible, hidden, or deleted',
      indexInverted: true
    }
  ]
};

/**
 * Initialize Weaviate schemas
 * Creates the schemas if they don't exist
 * 
 * @param {Object} client - Weaviate client instance
 */
async function initializeSchemas(client) {
  try {
    // Get all existing classes
    const existingClasses = await client.schema
      .getter()
      .do()
      .then((schema) => (schema.classes || []).map(c => c.class))
      .catch(() => []);

    // Check if Conversation schema exists
    if (!existingClasses.includes('Conversation')) {
      console.log('📝 Creating Conversation schema...');
      await client.schema.classCreator().withClass(CONVERSATION_SCHEMA).do();
      console.log('✅ Conversation schema created');
    } else {
      console.log('ℹ️  Conversation schema already exists');
      // Check if hashed_id property exists, add it if missing
      try {
        const conversationSchema = await client.schema.classGetter().withClassName('Conversation').do();
        const conversationProperties = (conversationSchema.properties || []).map(p => p.name);
        
        if (!conversationProperties.includes('hashed_id')) {
          console.log('➕ Adding hashed_id field to existing Conversation schema...');
          await client.schema
            .propertyCreator()
            .withClassName('Conversation')
            .withProperty({
              name: 'hashed_id',
              dataType: ['string'],
              description: 'Hashed room ID for universal identification across services (agentCode:clientId:userIdentifier)',
              indexFilterable: true
            })
            .do();
          console.log('✅ Successfully added hashed_id field to Conversation schema');
        }
      } catch (error) {
        console.warn('⚠️  Could not check/add hashed_id property:', error.message);
      }
    }

    // Check if ChatEvent schema exists
    if (!existingClasses.includes('ChatEvent')) {
      console.log('📝 Creating ChatEvent schema...');
      await client.schema.classCreator().withClass(CHATEVENT_SCHEMA).do();
      console.log('✅ ChatEvent schema created');
    } else {
      console.log('ℹ️  ChatEvent schema already exists');
    }
  } catch (error) {
    console.error('❌ Error initializing Weaviate schemas:', error);
    throw error;
  }
}

module.exports = {
  CONVERSATION_SCHEMA,
  CHATEVENT_SCHEMA,
  initializeSchemas
};

