/**
 * Stream Controller
 * Handles stream consumption and management
 */
class StreamController {
  constructor(streamService) {
    this.streamService = streamService;
  }

  /**
   * Get stream info
   * GET /api/v1/streams/info
   */
  async getStreamInfo(req, res, next) {
    try {
      const info = await this.streamService.getStreamInfo();
      res.json({
        success: true,
        stream: {
          name: this.streamService.getStreamName(),
          ...info
        }
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Read from stream (simple read)
   * GET /api/v1/streams/read
   */
  async readStream(req, res, next) {
    try {
      const {
        count = 10,
        block = 0,
        startId = '-', // New entries only by default
        endId = '+'
      } = req.query;

      const entries = await this.streamService.read({
        count: parseInt(count),
        block: parseInt(block),
        startId,
        endId
      });

      res.json({
        success: true,
        entries,
        count: entries.length
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Create consumer group
   * POST /api/v1/streams/groups
   */
  async createConsumerGroup(req, res, next) {
    try {
      const { groupName, startId = '0' } = req.body;

      if (!groupName) {
        return res.status(400).json({
          success: false,
          error: 'groupName is required'
        });
      }

      await this.streamService.createConsumerGroup(groupName, startId);

      res.status(201).json({
        success: true,
        message: `Consumer group '${groupName}' created successfully`
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Read from consumer group
   * GET /api/v1/streams/groups/:groupName/read
   */
  async readConsumerGroup(req, res, next) {
    try {
      const { groupName } = req.params;
      const {
        consumerName = `consumer-${Date.now()}`,
        count = 10,
        block = 5000
      } = req.query;

      const entries = await this.streamService.readGroup(
        groupName,
        consumerName,
        {
          count: parseInt(count),
          block: parseInt(block)
        }
      );

      res.json({
        success: true,
        groupName,
        consumerName,
        entries,
        count: entries.length
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Acknowledge message
   * POST /api/v1/streams/groups/:groupName/ack
   */
  async acknowledgeMessage(req, res, next) {
    try {
      const { groupName } = req.params;
      const { entryId } = req.body;

      if (!entryId) {
        return res.status(400).json({
          success: false,
          error: 'entryId is required'
        });
      }

      const count = await this.streamService.acknowledge(groupName, entryId);

      res.json({
        success: true,
        acknowledged: count
      });
    } catch (error) {
      next(error);
    }
  }
}

module.exports = StreamController;

