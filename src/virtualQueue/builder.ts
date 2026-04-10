/**
 * Virtual Queue Builder
 *
 * Fluent API for constructing virtual queue data structures.
 * Similar to TagBuilder, provides type-safe construction of queue objects.
 */

import type {
  LiveQueue,
  ReturnTimeState,
  BoardingGroupState,
  PriceData,
} from '@themeparks/typelib';

/**
 * Builder for RETURN_TIME queues
 */
export class ReturnTimeBuilder {
  private _state: ReturnTimeState = 'FINISHED';
  private _returnStart: string | null = null;
  private _returnEnd: string | null = null;

  /**
   * Set state to AVAILABLE (can join now, slots available)
   */
  available(): this {
    this._state = 'AVAILABLE';
    return this;
  }

  /**
   * Set state to TEMP_FULL (full now, but more slots later)
   */
  temporarilyFull(): this {
    this._state = 'TEMP_FULL';
    return this;
  }

  /**
   * Set state to FINISHED (all slots gone for the day)
   */
  finished(): this {
    this._state = 'FINISHED';
    return this;
  }

  /**
   * Set state directly
   */
  state(state: ReturnTimeState): this {
    this._state = state;
    return this;
  }

  /**
   * Set return time window
   * @param start - ISO 8601 datetime string or null
   * @param end - ISO 8601 datetime string or null
   */
  withWindow(start: string | null, end: string | null): this {
    this._returnStart = start;
    this._returnEnd = end;
    return this;
  }

  /**
   * Build the return time queue object
   */
  build(): NonNullable<LiveQueue['RETURN_TIME']> {
    return {
      state: this._state,
      returnStart: this._returnStart,
      returnEnd: this._returnEnd,
    };
  }
}

/**
 * Builder for PAID_RETURN_TIME queues
 */
export class PaidReturnTimeBuilder extends ReturnTimeBuilder {
  private _currency: string = 'USD';
  private _amount: number | null = 0;

  /**
   * Set price for paid return time.
   *
   * @param currency - Currency code (e.g., 'USD', 'EUR')
   * @param amountCents - Price in cents (e.g., 1500 for $15.00). Pass `null`
   *   when the API confirms a paid queue exists but does not expose the price
   *   (e.g. Tokyo Disney Premier Access). The built queue will have
   *   `amount: 0, formatted: 'Unknown'` so consumers can distinguish unknown
   *   from free.
   */
  withPrice(currency: string, amountCents: number | null): this {
    this._currency = currency;
    this._amount = amountCents;
    return this;
  }

  /**
   * Build the paid return time queue object
   */
  build(): NonNullable<LiveQueue['PAID_RETURN_TIME']> {
    const baseQueue = super.build();
    // typelib's PriceData.amount is required as `number`, so we can't
    // store `null` directly. Use the optional `formatted` field to mark
    // unknown prices — this is distinct from `amount: 0` which means free.
    const price = this._amount === null
      ? {currency: this._currency as any, amount: 0, formatted: 'Unknown'}
      : {currency: this._currency as any, amount: this._amount};
    return {
      ...baseQueue,
      price,
    };
  }
}

/**
 * Builder for BOARDING_GROUP queues
 */
export class BoardingGroupBuilder {
  private _allocationStatus: BoardingGroupState = 'CLOSED';
  private _currentGroupStart: number | null = null;
  private _currentGroupEnd: number | null = null;
  private _nextAllocationTime: string | null = null;
  private _estimatedWait: number | null = null;

  /**
   * Set status to AVAILABLE (accepting new boarding groups)
   */
  available(): this {
    this._allocationStatus = 'AVAILABLE';
    return this;
  }

  /**
   * Set status to PAUSED (temporarily paused, will resume)
   */
  paused(): this {
    this._allocationStatus = 'PAUSED';
    return this;
  }

  /**
   * Set status to CLOSED (not accepting today)
   */
  closed(): this {
    this._allocationStatus = 'CLOSED';
    return this;
  }

  /**
   * Set status directly
   */
  status(status: BoardingGroupState): this {
    this._allocationStatus = status;
    return this;
  }

  /**
   * Set current boarding group range
   * @param start - Starting group number (e.g., 45)
   * @param end - Ending group number (e.g., 60)
   */
  currentGroups(start: number | null, end: number | null): this {
    this._currentGroupStart = start;
    this._currentGroupEnd = end;
    return this;
  }

  /**
   * Set next allocation time
   * @param time - ISO 8601 datetime string or null
   */
  nextAllocationTime(time: string | null): this {
    this._nextAllocationTime = time;
    return this;
  }

  /**
   * Set estimated wait time in minutes
   */
  estimatedWait(minutes: number | null): this {
    this._estimatedWait = minutes;
    return this;
  }

  /**
   * Build the boarding group queue object
   */
  build(): NonNullable<LiveQueue['BOARDING_GROUP']> {
    return {
      allocationStatus: this._allocationStatus,
      currentGroupStart: this._currentGroupStart,
      currentGroupEnd: this._currentGroupEnd,
      nextAllocationTime: this._nextAllocationTime,
      estimatedWait: this._estimatedWait,
    };
  }
}

/**
 * Main builder class for creating virtual queue objects
 */
export class VQueueBuilder {
  /**
   * Create a return time queue builder (free virtual queue)
   *
   * @example
   * ```typescript
   * const queue = VQueueBuilder.returnTime()
   *   .available()
   *   .withWindow('2024-10-15T14:30:00-04:00', '2024-10-15T14:45:00-04:00')
   *   .build();
   * ```
   */
  static returnTime(): ReturnTimeBuilder {
    return new ReturnTimeBuilder();
  }

  /**
   * Create a paid return time queue builder
   *
   * @example
   * ```typescript
   * const queue = VQueueBuilder.paidReturnTime()
   *   .available()
   *   .withWindow(startTime, endTime)
   *   .withPrice('USD', 1500)
   *   .build();
   * ```
   */
  static paidReturnTime(): PaidReturnTimeBuilder {
    return new PaidReturnTimeBuilder();
  }

  /**
   * Create a boarding group queue builder
   *
   * @example
   * ```typescript
   * const queue = VQueueBuilder.boardingGroup()
   *   .available()
   *   .currentGroups(45, 60)
   *   .estimatedWait(30)
   *   .build();
   * ```
   */
  static boardingGroup(): BoardingGroupBuilder {
    return new BoardingGroupBuilder();
  }
}
