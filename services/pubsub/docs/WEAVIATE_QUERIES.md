# Weaviate Query Examples

This document provides example queries for retrieving chat history and performing semantic search using Weaviate.

## Prerequisites

- Weaviate instance running and accessible
- Conversation and ChatEvent schemas created
- Multi-tenancy enabled (tenant = agent_code)

## Environment Variables

```bash
WEAVIATE_URL=http://localhost:8080
WEAVIATE_API_KEY=optional-api-key
OPENAI_API_KEY=required-for-vectorizer
WEAVIATE_ENABLED=true
```

---

## 1. Chat Replay - Get All Events in a Conversation

Retrieve all chat events for a conversation, ordered by sequence number.

### GraphQL Query

```javascript
const weaviate = require('weaviate-ts-client');

const client = weaviate.client({
  scheme: 'http',
  host: 'localhost:8080',
});

const tenant = 'ginka-transaction-agent'; // agent_code
const conversationId = 'cs-gue:6282121547121'; // clientId:userIdentifier

const result = await client.graphql
  .get()
  .withClassName('ChatEvent')
  .withTenant(tenant)
  .withFields('conversation_id event_id event_type sender_type sender_id sender_display_name payload sequence created_at')
  .withWhere({
    path: ['conversation_id'],
    operator: 'Equal',
    valueString: conversationId
  })
  .withSort([{
    path: ['sequence'],
    order: 'asc'
  }])
  .withLimit(100)
  .do();

console.log('Chat Events:', result.data.Get.ChatEvent);
```

### Response Example

```json
{
  "data": {
    "Get": {
      "ChatEvent": [
        {
          "conversation_id": "cs-gue:6282121547121",
          "event_id": "wamid.HBgNNjI4...",
          "event_type": "message:incoming",
          "sender_type": "user",
          "sender_id": "6282121547121",
          "sender_display_name": "John Doe",
          "payload": {
            "eventType": "message:incoming",
            "content": "Hello, how are you?",
            ...
          },
          "sequence": 1,
          "created_at": "2024-01-15T10:30:45.123Z"
        },
        {
          "conversation_id": "cs-gue:6282121547121",
          "event_id": "ai-response-123",
          "event_type": "ai:response",
          "sender_type": "agent",
          "sender_id": "ginka-transaction-agent",
          "sender_display_name": null,
          "payload": {
            "eventType": "ai:response",
            "response": {
              "messages": [...]
            },
            ...
          },
          "sequence": 2,
          "created_at": "2024-01-15T10:30:50.456Z"
        }
      ]
    }
  }
}
```

---

## 2. Get Conversation Details

Retrieve conversation metadata including participants and status.

### GraphQL Query

```javascript
const conversationId = 'cs-gue:6282121547121';
const tenant = 'ginka-transaction-agent';

const result = await client.graphql
  .get()
  .withClassName('Conversation')
  .withTenant(tenant)
  .withFields('conversation_id title participant_ids created_at last_event_at status metadata')
  .withWhere({
    path: ['conversation_id'],
    operator: 'Equal',
    valueString: conversationId
  })
  .do();

console.log('Conversation:', result.data.Get.Conversation[0]);
```

### Response Example

```json
{
  "data": {
    "Get": {
      "Conversation": [
        {
          "conversation_id": "cs-gue:6282121547121",
          "title": null,
          "participant_ids": ["6282121547121", "ginka-transaction-agent", "cs-gue"],
          "created_at": "2024-01-15T10:30:45.123Z",
          "last_event_at": "2024-01-15T10:45:12.789Z",
          "status": "open",
          "metadata": {}
        }
      ]
    }
  }
}
```

---

## 3. List All Conversations for a Tenant

Get all conversations for a specific agent (tenant).

### GraphQL Query

```javascript
const tenant = 'ginka-transaction-agent';

const result = await client.graphql
  .get()
  .withClassName('Conversation')
  .withTenant(tenant)
  .withFields('conversation_id participant_ids created_at last_event_at status')
  .withSort([{
    path: ['last_event_at'],
    order: 'desc'
  }])
  .withLimit(50)
  .do();

console.log('Conversations:', result.data.Get.Conversation);
```

---

## 4. Semantic Search (RAG) - Vector Search

**Note: Vector search only works if embeddings were provided during event insertion.**

Search for similar chat events using vector similarity.

### GraphQL Query with Text Search

```javascript
const searchQuery = 'user asking about transaction status';
const tenant = 'ginka-transaction-agent';

// Using text-based vector search (requires text2vec-openai vectorizer)
const result = await client.graphql
  .get()
  .withClassName('ChatEvent')
  .withTenant(tenant)
  .withFields('conversation_id event_id event_type sender_type payload sequence created_at _additional { certainty distance }')
  .withNearText({
    concepts: [searchQuery],
    certainty: 0.7 // Minimum similarity threshold
  })
  .withLimit(10)
  .do();

console.log('Similar Events:', result.data.Get.ChatEvent);
```

### GraphQL Query with Custom Vector

If you have a pre-computed vector:

```javascript
const queryVector = [0.1, 0.2, 0.3, ...]; // Your embedding vector
const tenant = 'ginka-transaction-agent';

const result = await client.graphql
  .get()
  .withClassName('ChatEvent')
  .withTenant(tenant)
  .withFields('conversation_id event_id event_type payload _additional { certainty distance }')
  .withNearVector({
    vector: queryVector,
    certainty: 0.7
  })
  .withLimit(10)
  .do();

console.log('Similar Events:', result.data.Get.ChatEvent);
```

---

## 5. Filter Events by Type

Get only incoming messages or AI responses.

### GraphQL Query

```javascript
const tenant = 'ginka-transaction-agent';
const conversationId = 'cs-gue:6282121547121';

// Get only incoming messages
const incomingMessages = await client.graphql
  .get()
  .withClassName('ChatEvent')
  .withTenant(tenant)
  .withFields('event_id event_type sender_id payload sequence created_at')
  .withWhere({
    operator: 'And',
    operands: [
      {
        path: ['conversation_id'],
        operator: 'Equal',
        valueString: conversationId
      },
      {
        path: ['event_type'],
        operator: 'Equal',
        valueString: 'message:incoming'
      }
    ]
  })
  .withSort([{ path: ['sequence'], order: 'asc' }])
  .do();

// Get only AI responses
const aiResponses = await client.graphql
  .get()
  .withClassName('ChatEvent')
  .withTenant(tenant)
  .withFields('event_id event_type sender_id payload sequence created_at')
  .withWhere({
    operator: 'And',
    operands: [
      {
        path: ['conversation_id'],
        operator: 'Equal',
        valueString: conversationId
      },
      {
        path: ['event_type'],
        operator: 'Equal',
        valueString: 'ai:response'
      }
    ]
  })
  .withSort([{ path: ['sequence'], order: 'asc' }])
  .do();
```

---

## 6. Get Recent Events Across All Conversations

Retrieve the most recent events for a tenant.

### GraphQL Query

```javascript
const tenant = 'ginka-transaction-agent';

const result = await client.graphql
  .get()
  .withClassName('ChatEvent')
  .withTenant(tenant)
  .withFields('conversation_id event_id event_type sender_type sender_id payload sequence created_at')
  .withSort([{
    path: ['created_at'],
    order: 'desc'
  }])
  .withLimit(20)
  .do();

console.log('Recent Events:', result.data.Get.ChatEvent);
```

---

## 7. Search Events by Participant

Find all events involving a specific participant.

### GraphQL Query

```javascript
const tenant = 'ginka-transaction-agent';
const participantId = '6282121547121';

const result = await client.graphql
  .get()
  .withClassName('ChatEvent')
  .withTenant(tenant)
  .withFields('conversation_id event_id event_type sender_id participant_ids payload sequence created_at')
  .withWhere({
    path: ['participant_ids'],
    operator: 'ContainsAny',
    valueString: participantId
  })
  .withSort([{
    path: ['created_at'],
    order: 'desc'
  }])
  .withLimit(50)
  .do();

console.log('Events with participant:', result.data.Get.ChatEvent);
```

---

## 8. Full Chat History with Metadata

Get complete conversation history including all event details.

### JavaScript Function

```javascript
async function getFullChatHistory(client, tenant, conversationId) {
  // Get conversation details
  const conversationResult = await client.graphql
    .get()
    .withClassName('Conversation')
    .withTenant(tenant)
    .withFields('conversation_id participant_ids created_at last_event_at status')
    .withWhere({
      path: ['conversation_id'],
      operator: 'Equal',
      valueString: conversationId
    })
    .do();

  const conversation = conversationResult.data.Get.Conversation[0];

  // Get all events
  const eventsResult = await client.graphql
    .get()
    .withClassName('ChatEvent')
    .withTenant(tenant)
    .withFields('event_id event_type sender_type sender_id sender_display_name payload sequence created_at visibility')
    .withWhere({
      path: ['conversation_id'],
      operator: 'Equal',
      valueString: conversationId
    })
    .withSort([{ path: ['sequence'], order: 'asc' }])
    .do();

  return {
    conversation,
    events: eventsResult.data.Get.ChatEvent
  };
}

// Usage
const history = await getFullChatHistory(client, 'ginka-transaction-agent', 'cs-gue:6282121547121');
console.log(JSON.stringify(history, null, 2));
```

---

## Notes

1. **Multi-tenancy**: Always specify the tenant (agent_code) when querying. Events are isolated by tenant.

2. **Idempotency**: Events are idempotent by `event_id` within a conversation. Duplicate inserts are skipped.

3. **Vectors**: Vector search only works if embeddings were provided during event insertion. If no embedding was provided, the event won't be vectorized.

4. **Sequence Numbers**: Events have sequential numbers within a conversation, allowing proper ordering.

5. **Payload and Metadata**: The `payload` and `metadata` fields are stored as JSON strings (using `text` type) for maximum flexibility. Parse them when retrieving:
   ```javascript
   const event = result.data.Get.ChatEvent[0];
   const payload = JSON.parse(event.payload); // Parse JSON string to object
   const metadata = event.metadata ? JSON.parse(event.metadata) : {}; // Parse JSON string to object
   ```
   
   **Why `text` instead of `object`?**: Weaviate's `object` type requires nested properties to be defined upfront. Since our `payload` and `metadata` have completely arbitrary/flexible JSON structures, we use `text` type to store them as JSON strings. This allows storing any JSON structure without schema restrictions.

6. **Visibility**: Filter by `visibility` field if needed (values: 'visible', 'hidden', 'deleted').

