# Event Handlers Reference

This document provides detailed technical documentation for each event handler in the trade event handler service.

---

## Table of Contents

1. [Entry Handler](#entry-handler) - `handleEntryEvent`
2. [Jump Handler](#jump-handler) - `handleJumpEvent`
3. [Profit Handler](#profit-handler) - `handleProfitEvent` (planned)
4. [Stop Warning Handler](#stop-warning-handler) - `handleStopWarningEvent` (planned)
5. [Stop Out Handler](#stop-out-handler) - `handleStopOutEvent` (planned)
6. [Trade Closure Utility](#trade-closure-utility) - `closeTrade`

---

## Entry Handler

**File:** `handlers/entry.js`
**Function:** `handleEntryEvent(event, pool)`
**Status:** ✅ Complete and tested
**Trigger Event:** `entry-hit`

### Purpose

Processes entry-hit events when a trade crosses an entry price threshold. Updates the trade record, sets default stops and profit targets if needed, and notifies external systems.

### Event Schema

```javascript
{
  symbol: "AAPL",
  eventType: "entry-hit",
  tradeId: 123,
  direction: "Long" | "Short",
  data: {
    entryLevel: 1 | 2 | 3,      // Which entry was hit
    entryThreshold: 150.50,      // Price threshold that was crossed
    price: 150.52                // Actual price when detected
  }
}
```

### Processing Flow

#### 1. Idempotency Check

Prevents duplicate processing if the function is retried:

```javascript
SELECT id FROM lazy_swing_trade_events
WHERE trade_id = ? AND event_type = 'entry' AND price = ?
```

If a matching event exists, skip processing entirely.

**Why this works:** Once an entry is logged to the events table, it's immutable. Re-running won't change the outcome.

#### 2. Get Trade Details

Loads the full trade record to access all fields:

```javascript
SELECT * FROM lazy_swing_trades WHERE id = ?
```

Throws error if trade not found.

#### 3. Update Entry Fill Timestamp

Marks this specific entry as filled (idempotent):

```javascript
UPDATE lazy_swing_trades
SET entry_X_filled_at = NOW()
WHERE id = ? AND entry_X_filled_at IS NULL
```

The `IS NULL` check ensures this only runs once even if retried.

**Database field:** `entry_1_filled_at`, `entry_2_filled_at`, or `entry_3_filled_at`

#### 4. Set Default Stop (if none exist)

If the trade has no stops configured, create a breakeven daily stop:

```javascript
// Check for existing stops
SELECT * FROM lazy_swing_trade_stops WHERE trade_id = ?

// If none exist, create breakeven stop
INSERT INTO lazy_swing_trade_stops (trade_id, stop_type, operator, price)
VALUES (?, 'daily', ?, ?)
```

**Breakeven logic:**
- **Long trades:** `operator='below'`, `price=entryThreshold`
- **Short trades:** `operator='above'`, `price=entryThreshold`

**Why daily stops?** Allows intraday volatility while protecting against overnight gap risk.

#### 5. Set Default Profits (if none exist)

If the trade has no profit targets set, calculate and set default targets:

```javascript
// Check if any profit targets exist
const profits = [trade.profit_1, trade.profit_2, trade.profit_3].filter(p => p != null)

// If none exist, set defaults
if (!profits.length) {
  const profit1 = direction === 'Long' ? entryThreshold * 1.03 : entryThreshold * 0.97
  const profit2 = direction === 'Long' ? entryThreshold * 1.06 : entryThreshold * 0.94

  UPDATE lazy_swing_trades
  SET profit_1 = ?, profit_2 = ?
  WHERE id = ?
}
```

**Default profit targets:**
- **Profit 1:** +3% for longs, -3% for shorts
- **Profit 2:** +6% for longs, -6% for shorts

#### 6. Notify External Systems

Two integrations run in parallel (non-blocking):

**Promo System:**
```javascript
await sendToPromoSystem({
  symbol,
  direction,
  stopPrice: trade.stop_price,
  profit1: trade.profit_1,
  profit2: trade.profit_2
}, 'filled')
```

Creates a Cloud Task to send trade data to Google Apps Script endpoint.

**Alert System:**
```javascript
await publishAlert({
  symbol,
  eventType: 'entry-hit',
  data: { entryLevel }
})
```

Publishes to `alerts` topic for member email/SMS notifications.

**Error handling:** Both wrapped in `.catch()` so failures don't block main flow.

### Database Changes

| Table | Action | Fields |
|-------|--------|--------|
| `lazy_swing_trades` | UPDATE | `entry_X_filled_at = NOW()` |
| `lazy_swing_trades` | UPDATE | `profit_1`, `profit_2` (if null) |
| `lazy_swing_trade_stops` | INSERT | New breakeven stop (if none exist) |
| `lazy_swing_trade_events` | INSERT | Logged by `index.js` after handler completes |

### Example Scenario

**Initial State:**
```
Trade ID: 123
Symbol: AAPL
Direction: Long
entry_1: 150.50
entry_2: 151.00
entry_3: 151.50
entry_1_filled_at: NULL
entry_2_filled_at: NULL
entry_3_filled_at: NULL
profit_1: NULL
profit_2: NULL
profit_3: NULL
Stops: (none)
```

**Event Received:**
```javascript
{
  symbol: "AAPL",
  eventType: "entry-hit",
  tradeId: 123,
  direction: "Long",
  data: {
    entryLevel: 1,
    entryThreshold: 150.50,
    price: 150.52
  }
}
```

**After Processing:**
```
Trade ID: 123
Symbol: AAPL
Direction: Long
entry_1: 150.50
entry_2: 151.00
entry_3: 151.50
entry_1_filled_at: 2025-01-15 14:23:01  ← Set to NOW()
entry_2_filled_at: NULL
entry_3_filled_at: NULL
profit_1: 155.02                        ← 150.50 * 1.03
profit_2: 159.53                        ← 150.50 * 1.06
profit_3: NULL
Stops:
  - stop_type: daily, operator: below, price: 150.50  ← Breakeven stop
```

### Testing

**Test file:** `test-real-entry.js` or `test-index.js`

**To test idempotency:**
1. Run test once → Entry processed, defaults set
2. Run again with same event → Skipped due to duplicate check
3. Verify database wasn't modified twice

---

## Jump Handler

**File:** `handlers/jump.js`
**Function:** `handleJumpEvent(event, pool)`
**Status:** ✅ Complete and tested
**Trigger Event:** `jump-target`

### Purpose

Handles cases where price gaps over one or more unfilled entry levels at market open. Removes jumped entries, shifts remaining entries left, and closes the trade if the last entry was jumped with no fills.

### Event Schema

```javascript
{
  symbol: "AAPL",
  eventType: "jump-target",
  timestamp: "2025-01-15T09:30:00.000Z",
  tradeId: 123,
  direction: "Long",
  data: {
    openPrice: 155.00,           // Price at market open
    jumpedEntries: [             // Array of entries that were jumped
      {
        entryLevel: 1,
        entryThreshold: 150.50
      },
      {
        entryLevel: 2,
        entryThreshold: 151.00
      }
    ],
    jumpedPrices: "150.50, 151.00"  // Human-readable string
  }
}
```

### Processing Flow

#### 1. Get Trade Details

Load current trade state to see which entries exist:

```javascript
SELECT * FROM lazy_swing_trades WHERE id = ?
```

#### 2. Idempotency Check

Prevent duplicate processing by checking if the jumped thresholds still exist in the trade:

```javascript
// Extract current entry values
const currentThresholds = [
  parseFloat(trade.entry_1),
  parseFloat(trade.entry_2),
  parseFloat(trade.entry_3)
].filter(v => !isNaN(v))

// Check if ANY jumped threshold still exists
const PRICE_TOLERANCE = 0.00001  // Crypto-safe precision
const anyThresholdExists = jumpedThresholds.some(jumpedValue =>
  currentThresholds.some(currentValue =>
    Math.abs(currentValue - jumpedValue) < PRICE_TOLERANCE
  )
)

if (!anyThresholdExists) {
  // Already processed, skip
  return
}
```

**Why this works:** Once entries are shifted, the jumped values disappear from the trade record. If they're already gone, we know this event was already processed.

**Price tolerance:** Uses 0.00001 to handle floating point comparisons safely (supports crypto prices with 5 decimal places).

#### 3. Determine Rightmost Entry

Find the highest-numbered entry that has a value:

```javascript
let rightmostEntry = null
for (let i = 3; i >= 1; i--) {
  if (trade[`entry_${i}`] !== null) {
    rightmostEntry = i
    break
  }
}
```

**Example:**
- `entry_1=150, entry_2=151, entry_3=null` → rightmost is 2
- `entry_1=150, entry_2=null, entry_3=null` → rightmost is 1

#### 4. Check if Rightmost Entry Was Jumped

This is a critical decision point:

```javascript
const rightmostValue = parseFloat(trade[`entry_${rightmostEntry}`])
const rightmostJumped = jumpedThresholds.some(v =>
  Math.abs(v - rightmostValue) < PRICE_TOLERANCE
)

if (rightmostJumped) {
  // Check if any entries were filled
  const anyFilled = trade.entry_1_filled_at ||
                   trade.entry_2_filled_at ||
                   trade.entry_3_filled_at

  if (!anyFilled) {
    // Close the trade - no fills, last entry jumped
    await closeTrade(tradeId, symbol, 'jumped',
      `Rightmost entry (entry_${rightmostEntry}) jumped at ${openPrice} with no fills`,
      pool
    )
    return
  } else {
    // Has filled entries, keep active
    console.log('Trade has filled entries, continuing to monitor')
    return
  }
}
```

**Logic:**
- **Rightmost jumped + No fills** → Trade failed, close it
- **Rightmost jumped + Has fills** → Trade partially filled, keep monitoring
- **Rightmost NOT jumped** → Continue to step 5

#### 5. Process Jumped Entries (Shift Remaining)

Remove jumped entries and shift remaining entries left:

```javascript
// Collect remaining unfilled entries
const remainingUnfilled = []
for (let i = 1; i <= 3; i++) {
  const value = trade[`entry_${i}`]
  const filledAt = trade[`entry_${i}_filled_at`]

  if (value === null) continue

  const valueFloat = parseFloat(value)
  const isJumped = jumpedThresholds.some(jumpedValue =>
    Math.abs(jumpedValue - valueFloat) < PRICE_TOLERANCE
  )
  const isFilled = filledAt !== null

  // Keep if: not in jumped list, not filled
  if (!isJumped && !isFilled) {
    remainingUnfilled.push({ level: i, value })
  }
}

// Build new entry values by shifting remaining entries left
const newEntries = {
  entry_1: remainingUnfilled[0]?.value ?? null,
  entry_2: remainingUnfilled[1]?.value ?? null,
  entry_3: remainingUnfilled[2]?.value ?? null
}

// Single database update
UPDATE lazy_swing_trades
SET entry_1 = ?, entry_2 = ?, entry_3 = ?
WHERE id = ?
```

**Why single update?** More efficient than multiple updates, atomic operation.

### Database Changes

| Table | Action | Fields |
|-------|--------|--------|
| `lazy_swing_trades` | UPDATE | `entry_1`, `entry_2`, `entry_3` (shifted) |
| `lazy_swing_trades` | UPDATE | `status='closed'`, `outcome='jumped'` (if closing) |
| `lazy_swing_trade_events` | INSERT | Logged by `index.js` |

**If trade is closed:**
| Table | Event Published |
|-------|-----------------|
| `trade-event` topic | `trade-deleted` event to stop price tracking |

### Example Scenarios

#### Scenario 1: Jump Entry 1, Shift Remaining

**Before:**
```
entry_1: 150.00
entry_2: 151.00
entry_3: 152.00
entry_1_filled_at: NULL
entry_2_filled_at: NULL
entry_3_filled_at: NULL
```

**Event:**
```javascript
{
  eventType: "jump-target",
  data: {
    openPrice: 150.50,
    jumpedEntries: [{ entryLevel: 1, entryThreshold: 150.00 }]
  }
}
```

**After:**
```
entry_1: 151.00  ← Was entry_2
entry_2: 152.00  ← Was entry_3
entry_3: NULL    ← Cleared
```

**Outcome:** Trade still active, now monitoring 2 entries

---

#### Scenario 2: Jump Multiple Entries

**Before:**
```
entry_1: 150.00
entry_2: 151.00
entry_3: 152.00
entry_1_filled_at: NULL
entry_2_filled_at: NULL
entry_3_filled_at: NULL
```

**Event:**
```javascript
{
  eventType: "jump-target",
  data: {
    openPrice: 151.50,
    jumpedEntries: [
      { entryLevel: 1, entryThreshold: 150.00 },
      { entryLevel: 2, entryThreshold: 151.00 }
    ]
  }
}
```

**After:**
```
entry_1: 152.00  ← Was entry_3
entry_2: NULL
entry_3: NULL
```

**Outcome:** Trade still active, now monitoring 1 entry

---

#### Scenario 3: Jump Last Entry, No Fills → Close Trade

**Before:**
```
entry_1: 150.00
entry_2: NULL
entry_3: NULL
entry_1_filled_at: NULL
status: active
```

**Event:**
```javascript
{
  eventType: "jump-target",
  data: {
    openPrice: 155.00,
    jumpedEntries: [{ entryLevel: 1, entryThreshold: 150.00 }]
  }
}
```

**After:**
```
entry_1: 150.00  (unchanged)
entry_2: NULL
entry_3: NULL
entry_1_filled_at: NULL
status: closed       ← Set to closed
outcome: jumped      ← Set to jumped
closed_at: NOW()
closed_notes: "Rightmost entry (entry_1) jumped at 155.00 with no fills"
```

**Events Published:**
```javascript
// trade-deleted event sent to price worker
{
  eventType: 'trade-deleted',
  symbol: 'AAPL',
  tradeId: 123,
  data: {
    outcome: 'jumped',
    reason: 'Rightmost entry (entry_1) jumped at 155.00 with no fills'
  }
}
```

**Outcome:** Trade closed, price worker stops tracking

---

#### Scenario 4: Jump Last Entry, Has Fills → Keep Active

**Before:**
```
entry_1: 150.00
entry_2: 151.00
entry_3: NULL
entry_1_filled_at: 2025-01-14 14:00:00  ← Already filled
entry_2_filled_at: NULL
status: active
```

**Event:**
```javascript
{
  eventType: "jump-target",
  data: {
    openPrice: 152.00,
    jumpedEntries: [{ entryLevel: 2, entryThreshold: 151.00 }]
  }
}
```

**After:**
```
entry_1: 150.00
entry_2: 151.00  (unchanged)
entry_3: NULL
entry_1_filled_at: 2025-01-14 14:00:00
entry_2_filled_at: NULL
status: active   ← Still active
```

**Outcome:** Trade stays open, monitoring for profit/stop (entry_1 was filled)

### Testing

**Test file:** `test-jump.js`

**Test cases:**
1. Jump single entry → Verify shift
2. Jump multiple entries → Verify batch shift
3. Jump rightmost with no fills → Verify trade closed
4. Jump rightmost with fills → Verify trade stays open
5. Run same event twice → Verify idempotency

---

## Profit Handler

**File:** `handlers/profit.js`
**Function:** `handleProfitEvent(event, pool)`
**Status:** 🚧 Placeholder (not yet implemented)
**Trigger Event:** `profit-hit`

### Planned Event Schema

```javascript
{
  symbol: "AAPL",
  eventType: "profit-hit",
  tradeId: 123,
  direction: "Long",
  data: {
    profitLevel: 1 | 2 | 3,
    profitThreshold: 155.00,
    price: 155.02
  }
}
```

### Planned Processing Flow

1. **Idempotency check** - Check if this profit level already logged
2. **Update trade record** - Mark `profit_X_hit_at = NOW()`
3. **Determine action:**
   - **Profit 1:** Send alert, adjust stop to breakeven+
   - **Profit 2:** Send alert, trail stop tighter
   - **Profit 3:** Send alert, close trade with outcome 'profit'
4. **Send alerts** - Notify members of profit hit
5. **Update promo system** - Send profit stage data
6. **If closing:** Publish `trade-deleted` event

### Placeholder Implementation

Currently just logs the event:

```javascript
INSERT INTO lazy_swing_trade_events
(trade_id, symbol, event_type, target_number, price, notes)
VALUES (?, ?, 'profit', ?, ?, ?)
```

---

## Stop Warning Handler

**File:** `handlers/stop.js`
**Function:** `handleStopWarningEvent(event, pool)`
**Status:** 🚧 Placeholder (not yet implemented)
**Trigger Event:** `stop-warning`

### Planned Event Schema

```javascript
{
  symbol: "AAPL",
  eventType: "stop-warning",
  tradeId: 123,
  direction: "Long",
  data: {
    stopPrice: 148.00,
    price: 148.10,
    stopType: "daily" | "intraday",
    warningLevel: "approaching" | "critical"
  }
}
```

### Planned Processing Flow

1. **Send member broadcast alert** - Urgent notification that stop is approaching
2. **Log warning event** - Track how often stops are tested
3. **No database changes** - Trade remains active

### Placeholder Implementation

Currently just logs the event:

```javascript
INSERT INTO lazy_swing_trade_events
(trade_id, symbol, event_type, target_number, price, notes)
VALUES (?, ?, 'stop', ?, ?, ?)
```

---

## Stop Out Handler

**File:** `handlers/stop.js`
**Function:** `handleStopOutEvent(event, pool)`
**Status:** 🚧 Placeholder (not yet implemented)
**Trigger Event:** `stop-out`

### Planned Event Schema

```javascript
{
  symbol: "AAPL",
  eventType: "stop-out",
  tradeId: 123,
  direction: "Long",
  data: {
    stopPrice: 148.00,
    price: 147.50,
    stopType: "daily" | "intraday",
    slippage: 0.50
  }
}
```

### Planned Processing Flow

1. **Send member broadcast alert** - Urgent notification of stop hit
2. **Close trade:**
   ```javascript
   await closeTrade(
     tradeId,
     symbol,
     'stopped_out',
     `Stop hit at ${price}, stop was ${stopPrice}`,
     pool
   )
   ```
3. **Publish `trade-deleted` event** - Stop price tracking
4. **Update promo system** - Send closed stage data

### Placeholder Implementation

Currently just logs the event:

```javascript
INSERT INTO lazy_swing_trade_events
(trade_id, symbol, event_type, target_number, price, notes)
VALUES (?, ?, 'stop', ?, ?, ?)
```

---

## Trade Closure Utility

**File:** `handlers/reset.js`
**Function:** `closeTrade(tradeId, symbol, outcome, notes, pool)`
**Status:** ✅ Complete
**Used By:** Jump handler, stop handler (planned)

### Purpose

Centralized function for closing trades and publishing `trade-deleted` events to stop price worker tracking.

### Parameters

```javascript
/**
 * @param {number} tradeId - Trade ID
 * @param {string} symbol - Stock symbol
 * @param {string} outcome - 'profit', 'stopped_out', 'jumped', 'manual_reset', 'expired'
 * @param {string} notes - Reason/notes for closing
 * @param {object} pool - Database connection pool
 */
```

### Processing Flow

#### 1. Update Trade Status

```javascript
UPDATE lazy_swing_trades
SET status = 'closed',
    outcome = ?,
    closed_at = NOW(),
    closed_notes = ?
WHERE id = ?
```

**Fields:**
- `status` - Set to 'closed' (prevents detector from processing)
- `outcome` - One of: 'profit', 'stopped_out', 'jumped', 'expired'
- `closed_at` - Timestamp when trade was closed
- `closed_notes` - Human-readable reason for audit trail

#### 2. Publish trade-deleted Event

```javascript
const event = {
  eventType: 'trade-deleted',
  symbol,
  tradeId,
  timestamp: new Date().toISOString(),
  data: {
    outcome,
    reason: notes
  }
}

await pubsub.topic('trade-event').publishMessage({
  data: Buffer.from(JSON.stringify(event))
})
```

**Why this matters:** The price worker is still tracking this symbol and consuming Alpaca websocket bandwidth. Publishing `trade-deleted` tells it to unsubscribe and stop writing price updates.

### Example Usage

```javascript
// From jump handler - trade failed
await closeTrade(
  123,
  'AAPL',
  'jumped',
  'Rightmost entry (entry_3) jumped at 155.00 with no fills',
  pool
)

// From stop handler (planned)
await closeTrade(
  123,
  'AAPL',
  'stopped_out',
  'Stop hit at 147.50, stop was 148.00',
  pool
)

// From profit handler (planned)
await closeTrade(
  123,
  'AAPL',
  'profit',
  'Profit 3 hit at 160.00',
  pool
)
```

### Database Changes

| Table | Action | Fields |
|-------|--------|--------|
| `lazy_swing_trades` | UPDATE | `status='closed'`, `outcome`, `closed_at=NOW()`, `closed_notes` |

### Events Published

| Topic | Event Type | Purpose |
|-------|------------|---------|
| `trade-event` | `trade-deleted` | Stop price worker tracking |

### Error Handling

If event publishing fails, the error is logged and re-thrown:

```javascript
catch (error) {
  console.error(`Error closing trade ${tradeId}:`, error)
  throw error  // Cloud Function will retry entire event
}
```

**Why throw?** If we update the database but fail to publish the event, the price worker will keep tracking a closed trade. Better to retry the entire operation.

---

## Common Patterns

### Idempotency Checks

All handlers use idempotency checks to prevent duplicate processing:

**Entry handler:**
```javascript
// Check if exact entry already logged
SELECT id FROM lazy_swing_trade_events
WHERE trade_id = ? AND event_type = 'entry' AND price = ?
```

**Jump handler:**
```javascript
// Check if jumped thresholds still exist in trade
const anyThresholdExists = jumpedThresholds.some(jumped =>
  currentThresholds.some(current => Math.abs(current - jumped) < 0.00001)
)
```

**Why different approaches?**
- Entry events are immutable once logged → Check events table
- Jump events modify the trade record → Check if changes already applied

### Conditional Database Updates

Use `WHERE` clauses to make updates idempotent:

```javascript
// Only update if not already set
UPDATE lazy_swing_trades
SET entry_1_filled_at = NOW()
WHERE id = ? AND entry_1_filled_at IS NULL

// Only insert if doesn't exist
INSERT INTO lazy_swing_trade_stops (trade_id, stop_type, operator, price)
SELECT ?, ?, ?, ?
WHERE NOT EXISTS (
  SELECT 1 FROM lazy_swing_trade_stops WHERE trade_id = ?
)
```

### Non-Blocking External Calls

External integrations shouldn't block main flow:

```javascript
// Don't throw on promo system errors
await sendToPromoSystem(data, 'filled')
  .catch(err => console.error('Promo system error:', err))

// Don't throw on alert errors
await publishAlert(data)
  .catch(err => console.error('Alert error:', err))
```

### Error Handling Strategy

**Critical operations (database, PubSub):**
```javascript
throw error  // Let Cloud Function retry
```

**Non-critical operations (alerts, promo):**
```javascript
.catch(err => console.error(err))  // Log but continue
```

---

## Testing Handlers

### Local Testing Setup

Each handler has a test file in the project root:

```bash
# Test entry handler
node test-real-entry.js

# Test jump handler
node test-jump.js

# Test full flow
node test-index.js
```

### Test Database Configuration

Test files use direct TCP connection (not Cloud SQL socket):

```javascript
const dbConfig = {
  user: process.env.DB_USER || 'prod2',
  password: process.env.DB_PASS,
  database: process.env.DB_NAME || 'main',
  host: '35.229.104.1',  // Cloud SQL public IP
  port: 3306,
  ssl: false
}
```

### Testing Idempotency

**For entry handler:**
1. Run test with specific trade ID
2. Check database - entry filled, defaults set
3. Run same test again
4. Verify: "Entry X for trade Y already processed, skipping"
5. Check database - no duplicate records

**For jump handler:**
1. Set up trade with entries: `entry_1=150, entry_2=151, entry_3=152`
2. Send jump event for entry_1
3. Verify entries shifted: `entry_1=151, entry_2=152, entry_3=null`
4. Send same jump event again
5. Verify: "None of the jumped thresholds exist anymore, skipping"

---

## Handler Development Guidelines

When implementing new handlers (profit, stop):

1. **Start with idempotency check**
   - Determine if event was already processed
   - Return early if duplicate

2. **Load trade state**
   - Get full trade record
   - Verify trade exists

3. **Make database updates**
   - Use conditional updates where possible
   - Batch updates into single query when feasible

4. **Handle external integrations**
   - Wrap in try/catch
   - Don't throw on non-critical failures

5. **Close trade if needed**
   - Use `closeTrade()` utility
   - Ensure `trade-deleted` event is published

6. **Log and return**
   - Console.log key actions
   - Let index.js handle event logging

### Handler Template

```javascript
export async function handleNewEvent(event, pool) {
  const { symbol, tradeId, data } = event
  console.log(`Processing new-event for ${symbol}`)

  try {
    // 1. Idempotency check
    const [existing] = await pool.query(
      `SELECT id FROM lazy_swing_trade_events WHERE trade_id = ? AND ...`,
      [tradeId]
    )
    if (existing.length > 0) {
      console.log(`Event already processed for trade ${tradeId}, skipping`)
      return
    }

    // 2. Get trade details
    const [tradeRows] = await pool.query(
      `SELECT * FROM lazy_swing_trades WHERE id = ?`,
      [tradeId]
    )
    if (tradeRows.length === 0) {
      throw new Error(`Trade ${tradeId} not found`)
    }
    const trade = tradeRows[0]

    // 3. Update database
    await pool.query(
      `UPDATE lazy_swing_trades SET ... WHERE id = ?`,
      [tradeId]
    )

    // 4. External integrations (non-blocking)
    await publishAlert({ symbol, eventType: 'new-event', data })
      .catch(err => console.error('Alert error:', err))

    // 5. Close trade if needed
    if (shouldClose) {
      await closeTrade(tradeId, symbol, outcome, notes, pool)
    }

    console.log(`Event processed successfully for ${symbol}`)

  } catch (error) {
    console.error('Error processing event:', error)
    throw error
  }
}
```

---

## Debugging

### Common Issues

**"Trade X not found"**
- Trade doesn't exist in database
- Check tradeId in event matches database

**"Event already processed, skipping"**
- Normal behavior on retries
- Idempotency check working correctly

**"No stop set for trade X, setting breakeven stop"**
- Normal for first entry hit
- Ensures trade has downside protection

**"Trade X already has N stop(s) set"**
- Stops were manually configured
- Handler skips creating defaults

### Useful Queries

**Check recent events:**
```sql
SELECT * FROM lazy_swing_trade_events
WHERE created_at > DATE_SUB(NOW(), INTERVAL 1 HOUR)
ORDER BY created_at DESC;
```

**Check trade state:**
```sql
SELECT id, symbol, status, outcome,
       entry_1, entry_2, entry_3,
       entry_1_filled_at, entry_2_filled_at, entry_3_filled_at,
       profit_1, profit_2, profit_3
FROM lazy_swing_trades
WHERE id = ?;
```

**Check stops:**
```sql
SELECT * FROM lazy_swing_trade_stops
WHERE trade_id = ?;
```

**Find trades closed by outcome:**
```sql
SELECT id, symbol, outcome, closed_at, closed_notes
FROM lazy_swing_trades
WHERE status = 'closed' AND outcome = 'jumped'
ORDER BY closed_at DESC;
```
