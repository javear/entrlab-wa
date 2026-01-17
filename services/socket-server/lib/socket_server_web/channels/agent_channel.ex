defmodule SocketServerWeb.AgentChannel do
  use SocketServerWeb, :channel

  @doc """
  Channel for agent-wide updates.
  
  Automatically joins agents to their agent room based on agentCode from JWT.
  No payload needed - agentCode is extracted from socket assigns.
  
  This room broadcasts all conversation updates for the agent, useful for
  real-time conversation list updates in the UI.
  """
  def join("agent", _payload, socket) do
    agent_code = socket.assigns.agent_code

    if is_nil(agent_code) do
      {:error, %{reason: "not_authenticated"}}
    else
      # Hash the agent room ID
      hashed_id = SocketServer.Utils.RoomHash.hash_agent_room_id(agent_code)
      room_topic = "agent:#{hashed_id}"
      
      # Subscribe to the PubSub topic to receive broadcasts
      Phoenix.PubSub.subscribe(SocketServer.PubSub, room_topic)
      
      # Join the room
      socket = assign(socket, :room_topic, room_topic)
      
      {:ok, socket}
    end
  end

  def handle_info({:conversation_update, payload}, socket) do
    push(socket, "conversation_update", payload)
    {:noreply, socket}
  end
end
