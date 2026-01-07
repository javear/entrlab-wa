# Pub/Sub Service

Pub/Sub service using Valkey Stream for WhatsApp messages and AI responses. This service acts as a central event bus where other systems can subscribe to incoming messages and AI responses via webhooks or direct stream consumption.

## Features

- **Event Streaming**: Publishes incoming WhatsApp messages and AI responses to Valkey Stream
- **Webhook Subscriptions**: Register webhooks to receive events in real-time
- **Stream Consumption**: Direct stream consumption via consumer groups
- **Scalable**: Supports multiple consumers and webhook endpoints

## Architecture

```
┌─────────────────┐
│ Message Handlers│
│ (WPPConnect,    │
│  WA-Official)   │
└────────┬────────┘
         │
         │ Publish Events
         ▼
┌─────────────────┐
│  Valkey Stream  │
│ (whatsapp:events)│
└────────┬────────┘
         │
         ├───► Webhook Manager ───► HTTP Webhooks
         │
         └───► Stream Consumers ───► Custom Applications
```

## Environment Variables

```bash
# Valkey/Redis Connection (for streams - DB 0)
VALKEY_HOST=localhost
VALKEY_PORT=6379
VALKEY_PASSWORD=
VALKEY_DB=0
VALKEY_STREAM_NAME=whatsapp:events

# Valkey/Redis Connection (for webhooks - DB 1)
VALKEY_WEBHOOK_DB=1  # Optional, defaults to 1 if not set

# Service Port
PUBSUB_PORT=3005
```

## API Endpoints

### Webhooks

- `POST /api/v1/webhooks` - Register a webhook
- `GET /api/v1/webhooks` - List all webhooks
- `GET /api/v1/webhooks/:id` - Get webhook by ID
- `PUT /api/v1/webhooks/:id` - Update webhook
- `DELETE /api/v1/webhooks/:id` - Delete webhook
- `POST /api/v1/webhooks/:id/test` - Test webhook

### Streams

- `GET /api/v1/streams/info` - Get stream information
- `GET /api/v1/streams/read` - Read from stream
- `POST /api/v1/streams/groups` - Create consumer group
- `GET /api/v1/streams/groups/:groupName/read` - Read from consumer group
- `POST /api/v1/streams/groups/:groupName/ack` - Acknowledge message

## Usage

### Register a Webhook

```bash
curl -X POST http://localhost:3005/api/v1/webhooks \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://your-webhook-url.com/events",
    "eventTypes": ["message:incoming", "ai:response"],
    "secret": "your-webhook-secret",
    "headers": {
      "X-Custom-Header": "value"
    }
  }'
```

### Read from Stream

```bash
curl "http://localhost:3005/api/v1/streams/read?count=10&startId=-"
```

### Consumer Group Example

```bash
# Create consumer group
curl -X POST http://localhost:3005/api/v1/streams/groups \
  -H "Content-Type: application/json" \
  -d '{
    "groupName": "my-consumer-group",
    "startId": "0"
  }'

# Read from consumer group
curl "http://localhost:3005/api/v1/streams/groups/my-consumer-group/read?consumerName=my-consumer&count=10"
```

## Event Types

For detailed payload examples, see [PAYLOAD_EXAMPLES.md](./PAYLOAD_EXAMPLES.md).

### message:incoming

Published when a new message is received from a WhatsApp user.

**Webhook Payload:**
```json
{
  "event": {
    "eventType": "message:incoming",
    "timestamp": "2024-01-15T10:30:45.123Z",
    "clientId": "my-client-id",
    "platform": "wpp" | "wa-official",
    "userIdentifier": "6281234567890",
    "messageId": "message-id",
    "messageType": "text" | "image" | "video" | "audio" | "document",
    "content": "message content with metadata prefix",
    "metadata": {
      "sender": {
        "name": "John Doe",
        "phone": "6281234567890"
      },
      "message": {
        "from": "6281234567890@c.us",
        "timestamp": 1705317045,
        "hasMedia": false,
        "mediaUrls": []
      }
    }
  },
  "timestamp": "2024-01-15T10:30:45.123Z"
}
```

### ai:response

Published when an AI response is generated and sent.

**Webhook Payload:**
```json
{
  "event": {
    "eventType": "ai:response",
    "timestamp": "2024-01-15T10:30:50.456Z",
    "clientId": "my-client-id",
    "platform": "wpp" | "wa-official",
    "userIdentifier": "6281234567890",
    "agentCode": "goa-konsul",
    "requestMessage": "user's original message",
    "response": {
      "messages": [
        {
          "type": "text",
          "text": "AI response text"
        }
      ],
      "text": "text-only response (if messages is null)",
      "raw": {}
    },
    "metadata": {
      "processingTime": 5234
    }
  },
  "timestamp": "2024-01-15T10:30:50.456Z"
}
```

## Producer Integration

The service provides a producer client that can be used from other services:

```javascript
const { getProducer } = require('./services/pubsub/client/producer');

const producer = getProducer();

// Publish incoming message
await producer.publishIncomingMessage({
  clientId: 'client-id',
  platform: 'wpp',
  userIdentifier: '6281234567890',
  messageId: 'msg-123',
  messageType: 'text',
  content: 'Hello',
  metadata: { /* ... */ }
});

// Publish AI response
await producer.publishAIResponse({
  clientId: 'client-id',
  platform: 'wpp',
  userIdentifier: '6281234567890',
  agentCode: 'agent-1',
  requestMessage: 'Hello',
  response: { /* ... */ },
  metadata: { /* ... */ }
});
```

## Deployment

Use the provided `Dockerfile.pubsub` for deployment:

```bash
docker build -f Dockerfile.pubsub -t pubsub-service .
docker run -p 3005:3005 \
  -e VALKEY_HOST=valkey-host \
  -e VALKEY_PORT=6379 \
  -e VALKEY_PASSWORD=password \
  -e PUBSUB_PORT=3005 \
  pubsub-service
```
