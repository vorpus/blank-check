import { Global, Module } from "@nestjs/common";

import { EventBus } from "./event-bus.service";
import { OutboxRelay } from "./outbox-relay.service";

/**
 * EventsModule — the domain event bus + transactional outbox + relay (doc 01
 * §2.2). Global so any module can write outbox rows in its own transactions.
 */
@Global()
@Module({
  providers: [EventBus, OutboxRelay],
  exports: [EventBus, OutboxRelay],
})
export class EventsModule {}
