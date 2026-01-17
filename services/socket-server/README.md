# Socket Server Service

Elixir/Phoenix WebSocket server that consumes messages from Redis Streams and broadcasts them to WebSocket rooms for real-time chat updates.

## Features

- **Real-time Chat Updates**: Broadcasts chat events (message:incoming, ai:response, agent:response) to WebSocket clients
- **JWT Authentication**: Socket-level authentication with JWT tokens
- **Hashed Room IDs**: Secure room identification using HMAC-SHA256 hashing
- **Typing Indicators**: Support for typing indicators (prepared for future use)
- **Multi-agent Support**: Multiple agents can join the same conversation room

## Architecture

```
Redis Stream → Phoenix Consumer → Extract clientId + userIdentifier → Hash room ID (HMAC-SHA256) → Broadcast to Room → WebSocket Clients
```

## Room ID Format

### Conversation Rooms
**Room ID**: `conversation:{hashed_id}`

Where `hashed_id` = HMAC-SHA256(`agentCode:clientId:userIdentifier`, `ROOM_HASH_SECRET`)

- `agentCode` = Agent/tenant code (from JWT) - ensures tenant isolation
- `clientId` = WhatsApp client identifier
- `userIdentifier` = **WhatsApp user (customer)** who started/is participating in the conversation (phone number)
- **NOT** the person joining the room - that's an agent/staff member authenticated via JWT
- Different agents using the same `clientId` + `userIdentifier` will have different rooms (isolated by `agentCode`)
- This matches Weaviate's tenant structure where conversations are isolated by `agentCode` (tenant)

### Agent Rooms
**Room ID**: `agent:{hashed_id}`

Where `hashed_id` = HMAC-SHA256(`agentCode`, `ROOM_HASH_SECRET`)

- `agentCode` = Agent/tenant code (from JWT)
- Used for broadcasting all conversation updates for an agent
- Enables real-time conversation list updates in the UI
- Clients join automatically based on JWT (no payload needed)

## Environment Variables

- `PORT` - Server port (default: 4000, Railway will override)
- `VALKEY_HOST`, `VALKEY_PORT`, `VALKEY_PASSWORD` - Redis connection
- `VALKEY_STREAM_NAME` - Stream name (default: `whatsapp:events` - matches producer default)
- `SOCKET_CONSUMER_GROUP` - Consumer group name (default: `socket-server-consumer`)
- `SOCKET_CONSUMER_START_ID` - Start position (default: `$` for new messages)
- `WA_JWT_SECRET` - Shared JWT secret for token validation (REQUIRED, `JWT_SECRET` also accepted as fallback)
- `ROOM_HASH_SECRET` - Secret key for hashing room IDs (REQUIRED - use strong random string)

## Client Usage

### 1. Connect to Socket with JWT

```javascript
import {Socket} from "phoenix"

const socket = new Socket("ws://socket-server:4000/socket", {
  params: {
    token: "JWT_TOKEN_HERE"  // JWT with agentCode in payload
  }
})

socket.connect()
```

### 2. Join Agent Channel (for conversation list updates)

```javascript
// Join agent room to receive all conversation updates for this agent
// No payload needed - agentCode is extracted from JWT automatically

const agentChannel = socket.channel("agent", {})

agentChannel.join()
  .receive("ok", resp => {
    console.log("Joined agent room", resp)
  })
  .receive("error", resp => {
    console.error("Failed to join agent room", resp)
  })

// Listen for conversation updates (triggers conversation list refresh)
agentChannel.on("conversation_update", payload => {
  // payload: { event_id, event_type, conversation_id, client_id, user_identifier, timestamp }
  console.log("Conversation updated:", payload)
  // Refresh conversation list or update specific conversation in UI
  refreshConversationList()
})
```

### 3. Join Conversation Channel

```javascript
// Extract from REST API response:
// - clientId: "cs-gue"
// - userIdentifier: "6282121547121" (customer's phone number)

const channel = socket.channel("conversation", {
  client_id: "cs-gue",
  user_identifier: "6282121547121"
})

channel.join()
  .receive("ok", resp => {
    console.log("Joined conversation room", resp)
  })
  .receive("error", resp => {
    console.error("Failed to join", resp)
  })
```

### 4. Listen for Messages

```javascript
// Listen for messages in a specific conversation
channel.on("new_message", payload => {
  console.log("New message:", payload)
  // payload contains:
  // - event_id
  // - event_type: "message:incoming" | "ai:response" | "agent:response"
  // - content: JSON array of message objects
  // - sender: {type, id, displayName, roleLabel, avatarUrl}
  // - timestamp
  // - conversation_id
})
```

### 5. Typing Indicators (Future)

```javascript
// Listen for typing indicators
channel.on("typing", payload => {
  console.log("User is typing:", payload.user_name)
})

channel.on("stop_typing", payload => {
  console.log("User stopped typing:", payload.user_name)
})

// Send typing indicator
channel.push("typing", {
  user_id: "agent-123",
  user_name: "Agent Name",
  is_typing: true
})

// Send stop typing
channel.push("stop_typing", {
  user_id: "agent-123",
  user_name: "Agent Name",
  is_typing: false
})
```

## Authentication Flow

1. **Socket Level**: JWT token validated, `agentCode` extracted and stored in `socket.assigns.agent_code`
2. **Channel Level**: No JWT needed - uses `agentCode` from socket assigns
3. **Authorization**: Server validates agent has access to the conversation (optional)

## Development

### Prerequisites

**Redis/Valkey must be running** before starting the socket server. The service will retry connecting if Redis is not available, but it needs to be running for the stream consumer to work.

**Start Redis using one of these methods:**

```bash
# Option 1: Docker
docker run -d -p 6379:6379 --name redis redis:latest
# or
docker run -d -p 6379:6379 --name valkey valkey/valkey:latest

# Option 2: Homebrew (macOS)
brew install redis
brew services start redis
# or
brew install valkey
brew services start valkey

# Option 3: System service (Linux)
sudo systemctl start redis
# or
sudo systemctl start valkey

# Verify Redis is running
redis-cli ping
# Should return: PONG
```

### Setup

```bash
cd services/socket-server
mix deps.get
```

### Run

**From root folder:**
```bash
npm run socket-server-dev
```

**Or manually:**
```bash
# Set required environment variables (or use .env file)
export JWT_SECRET=your-jwt-secret
export ROOM_HASH_SECRET=your-room-hash-secret
export VALKEY_HOST=localhost
export VALKEY_PORT=6379

# Run the server
cd services/socket-server
mix phx.server
```

**Note:** The startup script (`scripts/start-socket-server.sh`) automatically loads environment variables from `.env` file in the project root.

### Build Release

```bash
MIX_ENV=prod mix release
```

## Docker

Build and run with Docker:

```bash
docker build -f Dockerfile.socket-server -t socket-server .
docker run -p 4000:4000 \
  -e JWT_SECRET=your-secret \
  -e ROOM_HASH_SECRET=your-hash-secret \
  -e VALKEY_HOST=redis \
  socket-server
```

## Health Check

The service exposes a health check endpoint at `/health`:

```bash
curl http://localhost:4000/health
```

Response:
```json
{
  "status": "ok",
  "service": "socket-server",
  "timestamp": "2026-01-13T10:00:00Z"
}
```

## Integration Points

- **Redis Stream**: Same stream as other services (`whatsapp:events` by default, configurable via `VALKEY_STREAM_NAME`)
- **JWT**: Same secret as main app for token validation
- **Port**: Railway's `PORT` environment variable (defaults to 4000)
- **No Weaviate dependency**: Room IDs constructed directly from stream events
- **Environment Variables**: All configuration reads from environment variables, which Railway can set in the deployment dashboard

## Future Features

### Typing Indicators
- **Status**: Infrastructure prepared, not yet integrated with stream events
- **Current Implementation**: Client-initiated typing indicators via channel events
- **Future Enhancement**: Integrate with WhatsApp typing indicators if available in stream
