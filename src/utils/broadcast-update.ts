import mongoose from 'mongoose';

/**
 * Update PlatformClientBroadcast when a message with broadcastId is delivered
 */
export async function updateBroadcastDelivered(
  broadcastUuid: string,
  userIdentifier: string | number
): Promise<void> {
  const uid = String(userIdentifier);
  try {
    const PlatformClientBroadcast = mongoose.model('PlatformClientBroadcast');
    const result = await PlatformClientBroadcast.findOneAndUpdate(
      { broadcast_uuid: broadcastUuid },
      {
        $inc: { 'counter.delivered': 1 },
        $push: {
          'target_activities.$[elem].events': {
            type: 'delivered',
            createdAt: new Date(),
            contents: []
          }
        }
      },
      {
        arrayFilters: [{ 'elem.userIdentifier': uid }],
        new: true
      }
    );
    if (result) {
      console.log(`✅ [Broadcast] Updated delivered for ${broadcastUuid} (user: ${uid})`);
    }
  } catch (err: any) {
    console.warn(`⚠️ [Broadcast] Failed to update delivered:`, err.message);
  }
}
