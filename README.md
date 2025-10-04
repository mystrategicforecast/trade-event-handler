# Trade Event Handler

Cloud Function service that processes trade lifecycle events from the Alpaca price worker detection system and manages trade state transitions, member alerts, and external system integrations.

## Overview

This service is part of a distributed trade management system:

- **Alpaca Price Worker** (separate project) → Detects price events (entry hits, profit hits, stops, jumps) → Publishes to `trade-event` topic
- **This Service** → Subscribes to `trade-event` topic → Processes events → Updates database → Notifies members → Publishes `trade-deleted` when closing trades

### What This Service Does

- ✅ Responds to trade detection events (entry-hit, profit-hit, stop-out, stop-warning, jump-target)
- ✅ Updates trade records and state in Cloud SQL database
- ✅ Closes trades when appropriate (stopped out, jumped with no fills)
- ✅ Publishes `trade-deleted` events to stop price worker tracking
- ✅ Sends Slack notifications for all events
- ✅ Logs all events to database with execution times
- ✅ Integrates with promo system and member alerts

### What This Service Does NOT Do

- ❌ Track live prices (that's the price worker's job)
- ❌ Detect entry/profit/stop events (that's the detector's job)
- ❌ Handle `trade-reset` events (price worker handles those from future UI)
- ❌ Create new trades (future admin UI will do that)

---

## Architecture

### Event Flow

```
┌─────────────────────┐
│  Alpaca Price       │
│  Worker + Detector  │ (separate project)
└──────────┬──────────┘
           │ Publishes events to trade-event topic:
           │ • entry-hit
           │ • profit-hit
           │ • stop-out
           │ • stop-warning
           │ • jump-target
           ▼
┌─────────────────────┐
│  trade-event topic  │
└──────────┬──────────┘
           │ Subscription: trade-event
           ▼
┌─────────────────────┐
│  THIS SERVICE       │
│  handleTradeEvent   │ (Cloud Function)
│  (index.js)         │
└──────────┬──────────┘
           │
           ├─► Slack Notification
           │
           ├─► Route to Handler (entry/profit/stop/jump)
           │   ├─► Update Database
           │   ├─► Close Trade (if needed)
           │   ├─► Publish trade-deleted (if closing)
           │   ├─► Trigger Member Alerts
           │   └─► Send to Promo System
           │
           └─► Log Event to Database
```

---

## Deployment

### Cloud Function Configuration

- **Function Name:** `handleTradeEvent`
- **Runtime:** Node.js 18+
- **Trigger:** Cloud Pub/Sub
- **Topic:** `trade-event`
- **Subscription:** `trade-event`
- **Entry Point:** `handleTradeEvent`
- **Region:** `us-east1`

### Environment Variables

```bash
# Database (Cloud SQL)
DB_USER=prod2
DB_PASS=<your-password>
DB_NAME=main

# External Integrations
SLACK_WEBHOOK_URL=<your-slack-webhook>
GOOGLE_CLOUD_PROJECT=cloud-functions-441521

# Feature Flags
ALERTS_TEST_MODE=true          # Set to 'false' to send alerts to all users (DANGEROUS)
PROMO_TEST_MODE=true           # Set to 'false' to send live promo data
```

### Database Connection

This service connects to Cloud SQL via Unix socket:

```javascript
socketPath: '/cloudsql/cloud-functions-441521:us-east1:inside-the-numbers-prod'
```

For local testing, use the TCP connection in test files (see `test-real-entry.js`).

---

## Event Handlers

See [EVENT_HANDLERS.md](./EVENT_HANDLERS.md) for detailed documentation of each handler.

| Event Type | Handler | Status | What It Does |
|------------|---------|--------|--------------|
| `entry-hit` | `handleEntryEvent` | ✅ Complete | Marks entry filled, sets default stops/profits, sends alerts (promo for entry_1 only) |
| `jump-target` | `handleJumpEvent` | ✅ Complete | Shifts remaining entries, closes trade if last entry jumped |
| `profit-hit` | `handleProfitEvent` | ✅ Complete | Marks profit achieved, sets breakeven stop on profit_1, closes trade when all profits hit |
| `stop-warning` | `handleStopWarningEvent` | ✅ Complete | Sends member alert warning that stop is approaching (5 min before close) |
| `stop-out` | `handleStopOutEvent` | ✅ Complete | Marks stop as triggered, sends alert, closes trade with status 'stopped_out' |

---

## Database Schema

### Tables Used

#### `lazy_swing_trades`
Main trade records with entry/profit/stop prices and fill timestamps.

Key fields:
- `id` - Trade ID
- `symbol` - Stock ticker
- `long_short` - Direction ('Long' or 'Short')
- `entry_1`, `entry_2`, `entry_3` - Entry price thresholds
- `entry_1_filled_at`, `entry_2_filled_at`, `entry_3_filled_at` - Fill timestamps
- `profit_1`, `profit_2`, `profit_3` - Profit target prices
- `profit_1_achieved_at`, `profit_2_achieved_at`, `profit_3_achieved_at` - Profit hit timestamps
- `status` - 'active' or 'closed'
- `outcome` - 'profit', 'stopped_out', 'jumped', 'expired'
- `closed_at` - When trade was closed
- `closed_notes` - Reason for closing

#### `lazy_swing_trade_stops`
Stop loss configuration for each trade.

Key fields:
- `trade_id` - Foreign key to lazy_swing_trades
- `stop_type` - 'daily' or 'weekly'
- `operator` - 'below' (for longs) or 'above' (for shorts)
- `price` - Stop price threshold
- `triggered_at` - Timestamp when stop was hit (for audit trail)

#### `lazy_swing_trade_events`
Event log with execution times for monitoring.

Key fields:
- `trade_id` - Foreign key to lazy_swing_trades
- `symbol` - Stock ticker
- `event_type` - 'entry', 'profit', 'stop', 'jump'
- `target_number` - Which entry/profit level (1, 2, or 3)
- `price` - Price at which event occurred
- `notes` - Human-readable event description
- `execution_time_ms` - Handler execution time
- `created_at` - Timestamp

---

## External Integrations

### 1. Slack Notifications

Sends real-time notifications to configured Slack webhook for all events.

**Implementation:** `index.js:buildSlackMessage()` and `postToSlack()`

**Examples:**
- `🎯 Jump: AAPL Long opened at 145.00, jumped entries: 1, 2`
- `📈 AAPL (Long) crossed entry_1 (150.50)`
- `💰 Profit 1 hit: AAPL Long at 155.00`
- `🛑 Stop out: AAPL Long at 148.00`

### 2. Member Alert System

Publishes to `alerts` topic which triggers the send-alerts Cloud Function to notify members via email/SMS.

**Implementation:** `utils/alerts.js:publishAlert()`

**Status:** Currently disabled (see line 43 in alerts.js)

**Test Mode:** Set `ALERTS_TEST_MODE=false` to send to all users (default: test user only)

**Message Format:**
```javascript
{
  newHits: [{ ticker: "AAPL", hitNumber: 1 }],
  alertType: "entry target" | "profit target" | "stop price" | "stop warning",
  channels: ["email", "sms"],
  options: { testUserOnly: true }
}
```

### 3. Promo System

Sends trade data to Google Apps Script endpoint via Cloud Tasks for promotional content generation.

**Implementation:** `utils/promo.js:sendToPromoSystem()`

**Stages:**
- `filled` - When entry is hit
- `closed` - When trade closes (future)

**Test Mode:** Set `PROMO_TEST_MODE=false` to send live data

**Queue:** `promo-system-queue` (must be created in Cloud Tasks)

### 4. Price Worker Communication

Publishes `trade-deleted` events to stop the price worker from tracking closed trades.

**Implementation:** `handlers/reset.js:closeTrade()`

**Event Schema:**
```javascript
{
  eventType: 'trade-deleted',
  symbol: 'AAPL',
  tradeId: 123,
  timestamp: '2025-01-15T12:00:00.000Z',
  data: {
    outcome: 'jumped' | 'stopped_out' | 'profit',
    reason: 'Human-readable reason'
  }
}
```

---

## Local Development

### Setup

```bash
npm install
```

### Testing Individual Handlers

Each handler has a test file that connects directly to the database:

```bash
# Test entry handler
node test-real-entry.js

# Test jump handler
node test-jump.js

# Test full flow (mimics index.js)
node test-index.js
```

**Note:** Test files use direct TCP connection to Cloud SQL. Update `dbConfig.host` with your Cloud SQL IP.

### Running Locally with Functions Framework

```bash
npm start
# Function runs at http://localhost:8080
```

Trigger with PubSub emulator or send test HTTP request.

---

## Handler Business Logic

### Entry Handler (`handleEntryEvent`)

**Trigger:** `entry-hit` event from detector

**Flow:**
1. **Idempotency check** - Skip if this entry already processed
2. **Update trade** - Mark `entry_X_filled_at = NOW()`
3. **Set default stop** - Breakeven stop at entry price (if no stops exist)
4. **Set default profits** - +3% and +6% targets (if none exist)
5. **Send to promo system** - Stage: 'filled'
6. **Publish alert** - Notify members

### Jump Handler (`handleJumpEvent`)

**Trigger:** `jump-target` event when price opens beyond unfilled entries

**Flow:**
1. **Get trade details** - Load current entry thresholds
2. **Idempotency check** - Skip if jumped thresholds no longer exist
3. **Check rightmost entry** - Was the last entry jumped?
   - **Yes + No fills** → Close trade with outcome 'jumped'
   - **Yes + Has fills** → Keep active, continue monitoring
   - **No** → Continue to step 4
4. **Shift entries** - Remove jumped entries, shift remaining left

**Example:**
- Trade has: `entry_1=150, entry_2=151, entry_3=152`
- Price jumps to 150.5, jumping entry_1
- Result: `entry_1=151, entry_2=152, entry_3=null`

### Stop Warning Handler (`handleStopWarningEvent`)

**Trigger:** `stop-warning` event from detector (5 min before close)

**Flow:**
1. **Send member alert** - Urgent warning that stop is approaching

**Note:** Does not modify database, just alerts members.

---

### Stop Out Handler (`handleStopOutEvent`)

**Trigger:** `stop-out` event from detector (5 min after close)

**Flow:**
1. **Idempotency check** - Skip if this stop-out already processed
2. **Get trade details** - Verify trade exists
3. **Find triggered stop** - Match stop by type (daily vs weekly)
4. **Mark stop as triggered** - Set `triggered_at = NOW()` for audit trail
5. **Send member alert** - Urgent notification of stop hit
6. **Close trade** - Call `closeTrade(tradeId, symbol, 'stopped_out', notes, pool)`
7. **Publish `trade-deleted`** event to stop price tracking

### Profit Handler (`handleProfitEvent`)

**Trigger:** `profit-hit` event from detector

**Flow:**
1. **Idempotency check** - Skip if this profit already processed
2. **Update trade** - Mark `profit_X_achieved_at = NOW()`
3. **Send member alert** - Notify members of profit hit
4. **Send to promo system** - Only for profit_1 (stage: 'profit')
5. **Check remaining profits** - Count non-null profit targets not yet achieved
6. **If profit_1 + more targets remain:**
   - Delete existing daily stops
   - Insert new daily stop at entry_1 price (breakeven stop)
7. **If no more targets remain:**
   - Close trade with `closeTrade(tradeId, symbol, 'profit', notes, pool)`
   - Publish `trade-deleted` event

---

## Monitoring

### Execution Times

All events are logged to `lazy_swing_trade_events` with `execution_time_ms` for performance monitoring.

**Query recent performance:**
```sql
SELECT symbol, event_type, AVG(execution_time_ms) as avg_ms, COUNT(*) as count
FROM lazy_swing_trade_events
WHERE created_at > DATE_SUB(NOW(), INTERVAL 7 DAY)
GROUP BY symbol, event_type;
```

### Cloud Function Logs

```bash
gcloud functions logs read handleTradeEvent --region=us-east1 --limit=50
```

**Key log messages:**
- `✅ Trade X closed with outcome 'Y' and trade-deleted event published`
- `✅ Shifted entries for trade X`
- `Entry X for trade Y already processed, skipping` (idempotency)

---

## Common Scenarios

### Scenario 1: Entry Hit

```
Event: entry-hit for AAPL entry_1 at 150.50
↓
Handler: handleEntryEvent
↓
Actions:
- Mark entry_1_filled_at = NOW()
- Create breakeven stop at 150.50 (if none exist)
- Set profit_1=155.02, profit_2=159.53 (if none exist)
- Send to promo system (stage: filled)
- Publish alert to members
↓
Result: Trade active, monitoring for profit/stop
```

### Scenario 2: Jump with No Fills

```
Event: jump-target, jumped entry_3 (rightmost), no fills
↓
Handler: handleJumpEvent
↓
Actions:
- Detect rightmost entry was jumped
- Check entry_X_filled_at columns → all NULL
- Call closeTrade(tradeId, symbol, 'jumped', notes, pool)
  - UPDATE lazy_swing_trades SET status='closed', outcome='jumped'
  - Publish trade-deleted event to stop price tracking
↓
Result: Trade closed, price worker stops tracking
```

### Scenario 3: Jump with Fills

```
Event: jump-target, jumped entry_1, but entry_2 was filled
↓
Handler: handleJumpEvent
↓
Actions:
- Detect rightmost entry NOT jumped (entry_3 still exists)
- Remove entry_1 from trade
- Shift: entry_1=entry_2, entry_2=entry_3, entry_3=NULL
↓
Result: Trade still active, now has 2 entries
```

### Scenario 4: Profit_1 Hit with More Targets

```
Event: profit-hit for AAPL profit_1 at 155.00
↓
Handler: handleProfitEvent
↓
Actions:
- Mark profit_1_achieved_at = NOW()
- Send member alert
- Send to promo system (stage: profit)
- Check remaining: profit_2=160, profit_3=165 (2 targets remain)
- Delete existing daily stops
- Insert new daily stop at entry_1 price (breakeven)
↓
Result: Trade active, now protected at breakeven, monitoring for profit_2
```

### Scenario 5: Final Profit Hit

```
Event: profit-hit for AAPL profit_3 at 165.00
State: profit_1 and profit_2 already achieved
↓
Handler: handleProfitEvent
↓
Actions:
- Mark profit_3_achieved_at = NOW()
- Send member alert
- Check remaining: none (all profits achieved)
- Call closeTrade(tradeId, symbol, 'profit', notes, pool)
  - UPDATE lazy_swing_trades SET status='closed', outcome='profit'
  - Publish trade-deleted event to stop price tracking
↓
Result: Trade closed successfully, price worker stops tracking
```

### Scenario 6: Stop Out

```
Event: stop-out for AAPL at 147.50 (stop was 148.50, daily close)
↓
Handler: handleStopOutEvent
↓
Actions:
- Idempotency check passes
- Find matching stop (daily stop ID 5 at 148.50)
- Mark stop as triggered: UPDATE lazy_swing_trade_stops SET triggered_at=NOW()
- Send member alert
- Call closeTrade(tradeId, symbol, 'stopped_out', notes, pool)
  - UPDATE lazy_swing_trades SET status='closed', outcome='stopped_out'
  - Publish trade-deleted event to stop price tracking
↓
Result: Trade closed at loss, stop marked as triggered, price worker stops tracking
```

---

## Error Handling

### Retries

Cloud Functions automatically retries on error. All handlers are designed to be **idempotent**:

- **Entry handler:** Checks if entry already processed via `lazy_swing_trade_events`
- **Jump handler:** Checks if jumped thresholds still exist in trade record
- **Database updates:** Use conditional updates where possible

### Failure Modes

**Database connection failure:**
- Cloud Function retries automatically
- Connection pool helps reuse connections

**External service failures (Promo/Alerts):**
- Logged but don't throw errors
- Main trade processing completes successfully

**Slack notification failure:**
- Throws error → Cloud Function retries entire event
- Consider wrapping in try/catch if Slack downtime shouldn't block processing

---

## Future Enhancements

- [ ] Complete profit handler implementation
- [ ] Complete stop handler implementation
- [ ] Enable member alert system
- [ ] Add trailing stop logic
- [ ] Implement partial profit taking
- [ ] Add trade analytics/reporting
- [ ] Build admin UI for trade management
- [ ] Add unit tests with mocked database

---

## Related Documentation

- [EVENT_HANDLERS.md](./EVENT_HANDLERS.md) - Detailed handler documentation
- Price Worker Trade Events Reference (separate project) - Event schemas and detector logic
