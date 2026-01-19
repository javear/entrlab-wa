defmodule SocketServerWeb.ConversationChannel do
  use SocketServerWeb, :channel

  @doc """
  Channel-level authorization and room joining.
  
  Accepts clientId and userIdentifier (customer's phone) in join payload.
  Hashes the room ID server-side using agentCode, clientId, and userIdentifier
  to ensure proper tenant isolation (matching Weaviate's tenant structure).
  """
  def join("conversation", payload, socket) do
    client_id = Map.get(payload, "client_id") || Map.get(payload, :client_id)
    user_identifier = Map.get(payload, "user_identifier") || Map.get(payload, :user_identifier)
    # Accept platform from payload (default to "wpp" if not provided)
    platform = Map.get(payload, "platform") || Map.get(payload, :platform) || "wpp"
    agent_code = socket.assigns.agent_code

    cond do
      is_nil(agent_code) ->
        {:error, %{reason: "not_authenticated"}}
      
      is_nil(client_id) or is_nil(user_identifier) ->
        {:error, %{reason: "missing_client_id_or_user_identifier"}}
      
      platform != "wpp" and platform != "wa-official" ->
        {:error, %{reason: "invalid_platform", message: "Platform must be 'wpp' or 'wa-official'"}}
      
      true ->
        # Hash the room ID with agentCode to ensure tenant isolation
        # Different agents using the same clientId + userIdentifier will have different rooms
        hashed_id = SocketServer.Utils.RoomHash.hash_room_id(agent_code, client_id, user_identifier)
        room_topic = "conversation:#{hashed_id}"
        
        # Subscribe to the PubSub topic to receive broadcasts
        Phoenix.PubSub.subscribe(SocketServer.PubSub, room_topic)
        
        # Join the room
        socket = assign(socket, :room_topic, room_topic)
        socket = assign(socket, :client_id, client_id)
        socket = assign(socket, :user_identifier, user_identifier)
        socket = assign(socket, :platform, platform)
        
        {:ok, socket}
    end
  end

  def handle_in("typing", payload, socket) do
    room_topic = socket.assigns.room_topic
    agent_code = socket.assigns.agent_code
    
    if room_topic do
      typing_payload = %{
        user_id: agent_code,
        user_name: Map.get(payload, "user_name") || Map.get(payload, :user_name) || agent_code,
        is_typing: true
      }
      
      SocketServerWeb.Endpoint.broadcast(room_topic, "typing", typing_payload)
      {:noreply, socket}
    else
      {:reply, {:error, %{reason: "not_joined_to_room"}}, socket}
    end
  end

  def handle_in("stop_typing", payload, socket) do
    room_topic = socket.assigns.room_topic
    agent_code = socket.assigns.agent_code
    
    if room_topic do
      typing_payload = %{
        user_id: agent_code,
        user_name: Map.get(payload, "user_name") || Map.get(payload, :user_name) || agent_code,
        is_typing: false
      }
      
      SocketServerWeb.Endpoint.broadcast(room_topic, "stop_typing", typing_payload)
      {:noreply, socket}
    else
      {:reply, {:error, %{reason: "not_joined_to_room"}}, socket}
    end
  end

  def handle_info({:new_message, payload}, socket) do
    push(socket, "new_message", payload)
    {:noreply, socket}
  end

  def handle_info({:typing, payload}, socket) do
    push(socket, "typing", payload)
    {:noreply, socket}
  end

  def handle_info({:stop_typing, payload}, socket) do
    push(socket, "stop_typing", payload)
    {:noreply, socket}
  end

  @doc """
  Handle send_message event from client.
  
  Validates the conversationId matches the socket's room and publishes
  the message to the Redis stream.
  
  ## Payload
  
  ```json
  {
    "conversationId": "mhSSVwWhku7HDR+5ukDJumRDin5Tx9BbZpsbkrDNapA=",
    "content": "Hello!",
    "messageType": "text"
  }
  ```
  
  ## Reply
  
  Success:
  ```json
  {
    "status": "ok",
    "entryId": "1768543834709-0",
    "message": "Message published successfully"
  }
  ```
  
  Error:
  ```json
  {
    "status": "error",
    "reason": "invalid_conversation_id" | "missing_content" | "publish_failed"
  }
  ```
  """
  def handle_in("send_message", payload, socket) do
    require Logger
    
    # Extract required fields from socket assigns
    agent_code = socket.assigns.agent_code
    client_id = socket.assigns.client_id
    user_identifier = socket.assigns.user_identifier
    platform = socket.assigns.platform || "wpp" # Default to "wpp" if not set
    sender_info = socket.assigns.sender_info || %{}
    
    # Extract payload fields
    conversation_id = Map.get(payload, "conversationId") || Map.get(payload, :conversationId)
    content = Map.get(payload, "content") || Map.get(payload, :content)
    message_type = Map.get(payload, "messageType") || Map.get(payload, :message_type) || "text"
    media_url = Map.get(payload, "mediaUrl") || Map.get(payload, :media_url)
    caption = Map.get(payload, "caption") || Map.get(payload, :caption)
    client_message_id = Map.get(payload, "clientMessageId") || Map.get(payload, :client_message_id) # Optional: idempotency key from client
    
    # Media types that require mediaUrl
    media_types = ["image", "video", "audio", "file", "document", "sticker"]
    
    cond do
      is_nil(agent_code) ->
        Logger.warning("send_message: not authenticated")
        {:reply, {:error, %{status: "error", reason: "not_authenticated"}}, socket}
      
      is_nil(client_id) or is_nil(user_identifier) ->
        Logger.warning("send_message: missing client_id or user_identifier in socket assigns")
        {:reply, {:error, %{status: "error", reason: "not_joined_to_room"}}, socket}
      
      is_nil(conversation_id) ->
        Logger.warning("send_message: missing conversationId in payload")
        {:reply, {:error, %{status: "error", reason: "missing_conversation_id"}}, socket}
      
      # For text messages, content is required. For media messages, content is optional (caption fallback).
      message_type not in media_types and (is_nil(content) or content == "") ->
        Logger.warning("send_message: missing or empty content for text message")
        {:reply, {:error, %{status: "error", reason: "missing_content", message: "Text messages require content"}}, socket}
      
      message_type in media_types and (is_nil(media_url) or media_url == "") ->
        Logger.warning("send_message: media message type '#{message_type}' requires mediaUrl")
        {:reply, {:error, %{status: "error", reason: "missing_media_url", message: "Media message types require a mediaUrl field"}}, socket}
      
      true ->
        # Calculate expected hashed_id from socket assigns
        expected_hashed_id = SocketServer.Utils.RoomHash.hash_room_id(agent_code, client_id, user_identifier)
        
        # Validate conversationId matches expected hashed_id
        if conversation_id != expected_hashed_id do
          Logger.warning("send_message: conversationId mismatch (expected: #{expected_hashed_id}, got: #{conversation_id})")
          {:reply, {:error, %{status: "error", reason: "invalid_conversation_id"}}, socket}
        else
          # Publish to stream (include platform, clientMessageId, mediaUrl, and caption)
          case SocketServer.Publishers.StreamPublisher.publish_outgoing_message(
            agent_code,
            client_id,
            user_identifier,
            content,
            message_type,
            sender_info,
            platform,
            client_message_id,
            media_url,
            caption
          ) do
            {:ok, entry_id} ->
              Logger.info("✅ send_message: Published successfully (entryId: #{entry_id}, conversationId: #{conversation_id}, platform: #{platform}#{if client_message_id, do: ", clientMessageId: #{client_message_id}", else: ""})")
              # Return clientMessageId in response if provided (for client idempotency matching)
              response = %{status: "ok", entryId: entry_id, message: "Message published successfully"}
              response = if client_message_id, do: Map.put(response, :clientMessageId, client_message_id), else: response
              {:reply, {:ok, response}, socket}
            
            {:error, reason} ->
              Logger.error("❌ send_message: Failed to publish - #{inspect(reason)}")
              {:reply, {:error, %{status: "error", reason: "publish_failed"}}, socket}
          end
        end
    end
  end
end

