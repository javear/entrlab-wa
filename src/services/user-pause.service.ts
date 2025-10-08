import { UserPause, IUserPause } from '../models/user-pause.model';

// ============================================
// User Pause Service
// Manages paused users per client
// ============================================

export class UserPauseService {
  /**
   * Check if a user is currently paused
   */
  async isUserPaused(clientId: string, phoneNumber: string): Promise<boolean> {
    try {
      const pauseRecord = await UserPause.findOne({
        clientId,
        phoneNumber,
        paused: true
      });

      if (!pauseRecord) {
        return false;
      }

      // Check if pause period has expired
      const now = new Date();
      if (now > pauseRecord.paused_till) {
        // Pause expired, update record
        pauseRecord.paused = false;
        await pauseRecord.save();
        return false;
      }

      return true;
    } catch (error) {
      console.error(`❌ Error checking pause status for ${phoneNumber}:`, error);
      return false; // Fail open - allow message if error
    }
  }

  /**
   * Pause a user
   */
  async pauseUser(
    clientId: string,
    phoneNumber: string,
    pausedTill: Date
  ): Promise<IUserPause> {
    try {
      const pauseRecord = await UserPause.findOneAndUpdate(
        { clientId, phoneNumber },
        {
          clientId,
          phoneNumber,
          paused: true,
          paused_at: new Date(),
          paused_till: pausedTill
        },
        {
          upsert: true,
          new: true
        }
      );

      console.log(`⏸️  User ${phoneNumber} paused on client ${clientId} until ${pausedTill.toISOString()}`);
      return pauseRecord;
    } catch (error) {
      console.error(`❌ Error pausing user ${phoneNumber}:`, error);
      throw error;
    }
  }

  /**
   * Unpause a user
   */
  async unpauseUser(clientId: string, phoneNumber: string): Promise<boolean> {
    try {
      const result = await UserPause.findOneAndUpdate(
        { clientId, phoneNumber },
        {
          paused: false,
          paused_till: new Date() // Set to now (expired)
        },
        { new: true }
      );

      if (result) {
        console.log(`▶️  User ${phoneNumber} unpaused on client ${clientId}`);
        return true;
      }

      return false;
    } catch (error) {
      console.error(`❌ Error unpausing user ${phoneNumber}:`, error);
      throw error;
    }
  }

  /**
   * Get pause status for a user
   */
  async getPauseStatus(
    clientId: string,
    phoneNumber: string
  ): Promise<IUserPause | null> {
    try {
      return await UserPause.findOne({ clientId, phoneNumber });
    } catch (error) {
      console.error(`❌ Error getting pause status:`, error);
      return null;
    }
  }

  /**
   * Get all paused users for a client
   */
  async getPausedUsers(clientId: string): Promise<IUserPause[]> {
    try {
      return await UserPause.find({
        clientId,
        paused: true,
        paused_till: { $gt: new Date() } // Only active pauses
      });
    } catch (error) {
      console.error(`❌ Error getting paused users:`, error);
      return [];
    }
  }

  /**
   * Clean up expired pauses
   */
  async cleanupExpiredPauses(): Promise<number> {
    try {
      const result = await UserPause.updateMany(
        {
          paused: true,
          paused_till: { $lt: new Date() }
        },
        {
          paused: false
        }
      );

      if (result.modifiedCount > 0) {
        console.log(`🧹 Cleaned up ${result.modifiedCount} expired pause(s)`);
      }

      return result.modifiedCount;
    } catch (error) {
      console.error(`❌ Error cleaning up expired pauses:`, error);
      return 0;
    }
  }

  /**
   * Delete a pause record
   */
  async deletePause(clientId: string, phoneNumber: string): Promise<boolean> {
    try {
      const result = await UserPause.deleteOne({ clientId, phoneNumber });
      return result.deletedCount > 0;
    } catch (error) {
      console.error(`❌ Error deleting pause record:`, error);
      return false;
    }
  }
}

