import * as mobx from "mobx";
import { AudioSystem } from "./AudioSystem";
import { TTSErrorInfo, TTSModelOptions, toModelOptions } from "./TTSModel";
import { AudioTextChunk } from "./AudioTextChunk"; // Added import

/** manages loading and caching of tracks */
export class ChunkLoader {
  private MAX_BACKGROUND_REQUESTS = 3;
  private MAX_LOCAL_TTL_MILLIS = 60 * 1000;

  private system: AudioSystem;
  private backgroundQueue: BackgroundRequest[] = [];
  // Count active *requests* (a batch counts as one active request for simplicity of queue processing trigger)
  private backgroundRequestsActiveCount = 0;
  private localCache: CachedAudio[] = [];
  private backgroundRequestProcessor: IntervalDaemon;
  private garbageCollector: IntervalDaemon;

  constructor({ system }: { system: AudioSystem }) {
    this.system = system;

    this.backgroundRequestProcessor = IntervalDaemon(
      this.processBackgroundQueue.bind(this),
      { interval: system.config.backgroundLoaderIntervalMillis },
    );
    this.garbageCollector = IntervalDaemon(this.processGarbage.bind(this), {
      interval: this.MAX_LOCAL_TTL_MILLIS / 2,
    }).startIfNot();
  }

  expireBefore = (
    position: number = this.system.audioStore?.activeText?.position ?? 0,
  ): void => {
    this.backgroundQueue = this.backgroundQueue.filter(
      (x) => !(x.position < position),
    );
  };

  /**
   * Removes locally cached audio (e.g., if ArrayBuffer becomes detached).
   * Does not affect storage cache.
   */
  uncache(text: string): void {
    this.localCache = this.localCache.filter((x) => x.text !== text);
  }

  preload(text: string, options: TTSModelOptions, position: number): void {
    // Check if already queued
    const alreadyQueued = this.backgroundQueue.some(
      (x) => x.text === text && mobx.comparer.structural(x.options, options),
    );
    if (alreadyQueued) {
      return;
    }

    // Check if already in local memory cache (loading or loaded)
    const alreadyLoaded = this.localCache.some(
      (x) => x.text === text && mobx.comparer.structural(x.options, options),
    );
    if (alreadyLoaded) {
      // Update requested time to prevent garbage collection if needed
      const cached = this.localCache.find(x => x.text === text && mobx.comparer.structural(x.options, options));
      if (cached) cached.requestedTime = Date.now();
      return;
    }
    this.backgroundQueue.push({
      text,
      options,
      requestedTime: Date.now(),
      position,
    });
    // Sort queue by position to prioritize upcoming chunks
    this.backgroundQueue.sort((a, b) => a.position - b.position);
    this.backgroundRequestProcessor.startIfNot();
  }

  /**
   * Requests audio for a given text and options.
   * Returns a promise that resolves with the ArrayBuffer.
   * Handles local caching and triggers background loading if necessary.
   */
  async load(text: string, options: TTSModelOptions): Promise<ArrayBuffer> {
    const existing = this.localCache.find(
      (x) =>
        x.text === text &&
        mobx.comparer.structural(x.options, options) // Use structural comparison
    );

    if (existing) {
      existing.requestedTime = Date.now(); // Update timestamp
      return existing.result; // Return existing promise (might be pending or resolved)
    }

    // 2. Check storage cache (before creating local entry/queueing)
    // Use options passed to `load` for cache lookup key consistency
    const stored: ArrayBuffer | null = await this.system.storage.getAudio(
      text,
      options,
    );
    if (stored) {
       // If found in storage, create a resolved entry in local cache
      // console.log(`Cache hit (storage): ${text.substring(0, 20)}...`);
       const audio = this.createCachedAudio(text, options);
       audio.resolve(stored); // Immediately resolve
       this.localCache.push(audio);
       return audio.result;
    }


    // 3. Not in local or storage cache - create local entry and queue for loading
    // console.log(`Cache miss: ${text.substring(0,20)}...`);
    const audio = this.createCachedAudio(text, options);
    this.localCache.push(audio);

    // Ensure it's added to the background queue if not already there
    // (preload might have already added it)
    const position = 
      this.system.audioStore?.activeText?.audio.chunks.findIndex((c: AudioTextChunk) => c.text === text) ?? Infinity;
    this.preload(text, options, position); // preload handles queueing logic

    return audio.result; // Return the pending promise
  }

  destroy(): void {
    this.backgroundRequestProcessor.stop();
    this.garbageCollector.stop();
    // Clear caches and queue on destroy
    this.localCache = [];
    this.backgroundQueue = [];
    this.backgroundRequestsActiveCount = 0;
  }

  private createCachedAudio(
    text: string,
    options: TTSModelOptions,
  ): CachedAudio {
    let resolve!: (value: ArrayBuffer | PromiseLike<ArrayBuffer>) => void;
    let reject!: (reason?: any) => void;

    const promise = new Promise<ArrayBuffer>((res, rej) => {
      resolve = res;
      reject = rej;
    });

    // Wrap reject to automatically remove from cache on failure
    const rejectAndClean = (reason?: any) => {
      this.destroyCachedAudio(audio); // Remove from local cache on failure
      reject(reason);
    };


    const audio: CachedAudio = {
      text,
      options,
      requestedTime: Date.now(),
      result: promise,
      resolve: resolve, // Store the original resolve
      reject: rejectAndClean, // Store the wrapped reject
    };
    return audio;
  }

  private destroyCachedAudio(audio: CachedAudio): void {
    const index = this.localCache.indexOf(audio);
    if (index !== -1) {
      this.localCache.splice(index, 1);
    }
  }


  // Processes the queue, deciding whether to batch (Hume) or send individually
  private processBackgroundQueue(): boolean {
    if (this.backgroundRequestsActiveCount >= this.MAX_BACKGROUND_REQUESTS) {
      // console.log("Queue: Max active requests reached.");
      return true;
    }
    if (this.backgroundQueue.length === 0) {
      // console.log("Queue: Empty.");
      return false; // Stop timer if queue is empty
    }

    const isHume = this.system.settings.modelProvider === 'hume';

    if (isHume && this.system.humeBatchTTSModel) {
      // --- Hume Batch Processing ---
      // Determine batch size (up to remaining slots, max queue length)
      const availableSlots = this.MAX_BACKGROUND_REQUESTS - this.backgroundRequestsActiveCount;
      const batchSize = Math.min(this.backgroundQueue.length, availableSlots, 5); // Hume might have utterance limits, adjust '5' if needed

      if (batchSize === 0) return true; // Should not happen based on checks, but safety

      const batchItems = this.backgroundQueue.splice(0, batchSize); // Take items from front
      const texts = batchItems.map(item => item.text);
      // Use options from the *first* item for the batch API call (Hume continuation assumption)
      // Regenerate options based on *current* settings for the API call itself
      const currentOptions = toModelOptions(this.system.settings);
      // Ensure the specific voice/instructions from the *first* queued item are used if they differ from current defaults
      const batchApiOptions: TTSModelOptions = {
        ...currentOptions, // Start with current settings
        voice: batchItems[0].options.voice || currentOptions.voice,
        instructions: batchItems[0].options.instructions || currentOptions.instructions,
        // Keep other options like speed from current settings unless needed otherwise
      };


      // console.log(`Queue: Starting Hume batch request for ${batchItems.length} items.`);
      this.backgroundRequestsActiveCount += 1; // Increment active *requests* count by 1 for the batch

      this.tryLoadBatchTrack(texts, batchApiOptions, batchItems, 0, 3)
        .then(async (results) => {
          // console.log(`Queue: Hume batch success (${batchItems.length} items).`);
          if (results.length !== batchItems.length) {
            throw new Error(`Hume batch returned ${results.length} results for ${batchItems.length} texts.`);
          }
          for (let i = 0; i < batchItems.length; i++) {
            const item = batchItems[i];
            const resultBuffer = results[i];
            const cached = this.findCachedAudio(item.text, item.options);
            if (cached) {
              cached.resolve(resultBuffer);
              try {
                // Cache in storage using the *original* options key from the item
                await this.system.storage.saveAudio(item.text, item.options, resultBuffer);
              } catch (saveError) {
                console.error("Error saving batch item to storage:", saveError);
                // Don't reject the main promise, just log the save error
              }
            } else {
              console.warn("Could not find local cache entry to resolve for batch item:", item.text.substring(0,20));
            }
          }
        })
        .catch((error) => {
          console.error(`Queue: Hume batch failed:`, error);
          // Reject promises for all items in the failed batch
          for (const item of batchItems) {
            const cached = this.findCachedAudio(item.text, item.options);
            if (cached) {
              cached.reject(error); // Reject pending promise (triggers cleanup)
            }
          }
        })
        .finally(() => {
          // console.log(`Queue: Hume batch finished.`);
          this.backgroundRequestsActiveCount -= 1; // Decrement active requests count
          this.processBackgroundQueue(); // Immediately check if more work can be done
        });

    } else {
      // --- OpenAI / Compatible / Non-Batch Processing ---
      const item = this.backgroundQueue.shift()!; // Take one item
      // console.log(`Queue: Starting single request for: ${item.text.substring(0,20)}...`);
      this.backgroundRequestsActiveCount += 1; // Increment active requests count

      // We re-fetch from cache here just in case it arrived via storage check between queueing and processing
      // The `load` function handles this check internally now. We call `load` again, but it should hit
      // the pending promise in localCache and not trigger a new API call if already initiated.
      // If the promise associated with the cache entry resolves/rejects, it handles storage saving/cleanup.
      this.load(item.text, item.options)
        .then(() => {
          // console.log(`Queue: Single request success: ${item.text.substring(0,20)}...`);
          // Resolution handled by the promise mechanism in `load` and `createCachedAudio`
        })
        .catch((error) => {
          console.error(`Queue: Single request failed: ${item.text.substring(0,20)}...`, error);
          // Rejection handled by the promise mechanism
        })
        .finally(() => {
          // console.log(`Queue: Single request finished: ${item.text.substring(0,20)}...`);
          this.backgroundRequestsActiveCount -= 1;
          this.processBackgroundQueue(); // Check for more work
        });
    }

    return true; // Keep processor running if queue might still have items or requests are active
  }

  private processGarbage(): boolean {
    this.localCache = this.localCache.filter(
      (entry) => Date.now() - entry.requestedTime < this.MAX_LOCAL_TTL_MILLIS,
    );
    return true;
  }

  // Finds a specific entry in the local cache
  private findCachedAudio(text: string, options: TTSModelOptions): CachedAudio | undefined {
     return this.localCache.find(
          (x) =>
            x.text === text &&
            mobx.comparer.structural(x.options, options)
      );
  }

  // --- Batch Loading Retry Logic ---
  private async tryLoadBatchTrack(
      texts: string[],
      options: TTSModelOptions,
      originalItems: BackgroundRequest[], // Keep original items for context if needed
      attempt: number,
      maxAttempts: number,
  ): Promise<ArrayBuffer[]> {
    try {
        if (!this.system.humeBatchTTSModel) {
           throw new Error("Hume batch model not available in AudioSystem");
        }
        // **Decision:** Skip storage check for batch simplicity for now.
        // Could add checks here later:
        // 1. Check storage for each text.
        // 2. Build list of texts still needing API call.
        // 3. Make API call only for missing texts.
        // 4. Reconstruct full results array using storage hits + API results.

        // Make the API call using CURRENT options derived for the batch
        return await this.system.humeBatchTTSModel(texts, options);

    } catch (ex) {
      console.warn(`Batch load attempt ${attempt + 1} failed for ${texts.length} items.`, ex);
      const errorInfo = ex instanceof TTSErrorInfo ? ex : undefined;
      const canRetry = attempt < maxAttempts && (errorInfo ? errorInfo.isRetryable : !(ex instanceof Error && ex.message.includes("Unexpected Hume API response format"))); // Don't retry fatal format errors

      if (!canRetry) {
        console.error(`Batch load failed permanently after ${attempt + 1} attempts.`);
        throw ex; // Propagate error after max retries or for non-retryable errors
      } else {
        const delay = 250 * Math.pow(2, attempt);
        console.log(`Retrying batch load in ${delay}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        return this.tryLoadBatchTrack(texts, options, originalItems, attempt + 1, maxAttempts);
      }
    }
  }
}

// --- Helper Interfaces and Functions ---
interface IntervalDaemon {
  stop: () => IntervalDaemon;
  startIfNot: () => IntervalDaemon;
}

type ShouldContinue = boolean;

/** runs the work function every interval, until the work function returns false. Can be stopped and started. */
export function IntervalDaemon(
  doWork: () => ShouldContinue,
  opts: {
    interval: number;
  },
): IntervalDaemon {
  let timer: undefined | ReturnType<typeof setInterval>;
  const processor: IntervalDaemon = {
    stop: () => {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
      return processor;
    },
    startIfNot: () => {
      if (timer !== undefined) {
        return processor;
      }
      let shouldContinue = true;
      try {
        shouldContinue = doWork();
      } catch (ex) {
         // Decide whether to stop or continue based on error? For now, assume continue.
         shouldContinue = true;
      }
      if (shouldContinue) {
        timer = setInterval(() => {
          let shouldContinueInterval = true;
          try {
            shouldContinueInterval = doWork();
          } catch (ex) {
             // Decide whether to stop or continue based on error? For now, assume continue.
             shouldContinueInterval = true;
          }
          if (!shouldContinueInterval) {
            processor.stop();
          }
        }, opts.interval);
      }
      return processor;
    },
  };
  return processor;
}

interface BackgroundRequest {
  /** the text that was requested */
  text: string;
  /** the options used to generate this audio */
  options: TTSModelOptions;
  /** the time the request was made. Milliseconds since Unix Epoch */
  requestedTime: number;
  /** the track number that was requested */
  position: number;
}

interface CachedAudio {
  /** the text that was requested */
  readonly text: string;
  /** the options used to generate this audio */
  readonly options: TTSModelOptions;
  /** the final result of the request across retries */
  readonly result: Promise<ArrayBuffer>;
  /** Function to resolve the result promise */
  resolve: (value: ArrayBuffer | PromiseLike<ArrayBuffer>) => void;
   /** Function to reject the result promise */
  reject: (reason?: any) => void;
  /** the time the request was made/last accessed. Milliseconds since Unix Epoch. Updated to prevent GC. */
  requestedTime: number;
}
