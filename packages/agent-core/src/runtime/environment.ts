import {
  FunctionCallItem,
  FunctionCallOutputItem,
  ModelMessageItem,
  Participant,
  RuntimeState,
  SemanticEvent,
  SituationSpecification,
  defineRuntime,
  type SituationContext,
  type SituationHandler,
} from "@mozaik-ai/core";

class MessageFromOthers extends SituationSpecification {
  isSatisfiedBy({ event, participant }: SituationContext): boolean {
    return event.type === "message.sent" && event.producerId !== participant.getId();
  }
}

class FunctionCallStarted extends SituationSpecification {
  isSatisfiedBy({ event }: SituationContext): boolean {
    return event.type === "function_call.started";
  }
}

class FunctionCallCompleted extends SituationSpecification {
  isSatisfiedBy({ event }: SituationContext): boolean {
    return event.type === "function_call.completed";
  }
}

class ModelAnswered extends SituationSpecification {
  isSatisfiedBy({ event }: SituationContext): boolean {
    return event.type === "model.answer";
  }
}

class CustomEventFromOthers extends SituationSpecification {
  isSatisfiedBy({ event, participant }: SituationContext): boolean {
    if (event.producerId === participant.getId()) {
      return false;
    }
    return !LOOP_EVENT_TYPES.has(event.type);
  }
}

const LOOP_EVENT_TYPES = new Set([
  "message.sent",
  "function_call.started",
  "function_call.completed",
  "model.answer",
  "participant.joined",
  "participant.left",
]);

class EnvironmentState extends RuntimeState {}

export type BusEvent = SemanticEvent<string, unknown>;

export function createSemanticEvent<T>(
  type: string,
  payload: T,
  producerId = "test",
): SemanticEvent<string, T> {
  return SemanticEvent.create(type, producerId, payload);
}

export class AgenticEnvironment {
  private readonly api = defineRuntime<RuntimeState>();

  constructor() {
    this.api.initializeRuntime({ state: new EnvironmentState() });
  }

  join(participant: Participant): void {
    this.api.join(participant);
  }

  sendUserMessage(text: string, sender: Participant): void {
    this.api.sendMessage(text, sender.getId());
  }

  deliverSemanticEvent(caller: Participant, event: BusEvent): void {
    this.api.sendEvent(event, caller.getId());
  }

  deliverFunctionCall(caller: Participant, item: FunctionCallItem): void {
    this.api.sendEvent(
      SemanticEvent.create("function_call.started", caller.getId(), { call: item }),
      caller.getId(),
    );
  }

  deliverFunctionCallOutput(caller: Participant, item: FunctionCallOutputItem): void {
    this.api.sendEvent(
      SemanticEvent.create("function_call.completed", caller.getId(), item),
      caller.getId(),
    );
  }

  deliverModelMessage(caller: Participant, item: ModelMessageItem): void {
    this.api.sendEvent(
      SemanticEvent.create("model.answer", caller.getId(), { answer: item }),
      caller.getId(),
    );
  }

  getParticipants(): readonly Participant[] {
    return this.api.resolveRuntime().state.getParticipants();
  }
}

export class BaseParticipant extends Participant {
  constructor(name = "participant", role: "agent" | "human" = "human") {
    super({ id: crypto.randomUUID(), name, role, capabilities: [] }, []);
    this.setHandlers(this.buildHandlers());
  }

  join(environment: AgenticEnvironment): void {
    environment.join(this);
  }

  markActive(_environment?: AgenticEnvironment): void {
    return;
  }

  onMessage(_message: string): void {
    return;
  }

  onFunctionCall(_item: FunctionCallItem): void {
    return;
  }

  onFunctionCallOutput(_item: FunctionCallOutputItem): void {
    return;
  }

  onModelMessage(_item: ModelMessageItem): void {
    return;
  }

  onError(_error: Error): void {
    return;
  }

  onExternalFunctionCall(_source: Participant, _item: FunctionCallItem): void {
    return;
  }

  onExternalFunctionCallOutput(_source: Participant, _item: FunctionCallOutputItem): void {
    return;
  }

  onExternalModelMessage(): void {
    return;
  }

  onExternalEvent(_source: Participant, _item: BusEvent): void {
    return;
  }

  private buildHandlers(): SituationHandler[] {
    return [
      {
        specification: new MessageFromOthers(),
        processor: {
          apply: ({ event }) => {
            const message = (event.payload as { message?: unknown }).message;
            if (typeof message === "string") {
              this.onMessage(message);
            }
          },
        },
      },
      {
        specification: new FunctionCallStarted(),
        processor: {
          apply: ({ event, participant }) => {
            const call = (event.payload as { call?: FunctionCallItem }).call;
            if (!call) {
              return;
            }
            if (event.producerId === participant.getId()) {
              this.onFunctionCall(call);
              return;
            }
            this.onExternalFunctionCall(new BaseParticipant(event.producerId), call);
          },
        },
      },
      {
        specification: new FunctionCallCompleted(),
        processor: {
          apply: ({ event, participant }) => {
            const item = event.payload as FunctionCallOutputItem;
            if (event.producerId === participant.getId()) {
              this.onFunctionCallOutput(item);
              return;
            }
            this.onExternalFunctionCallOutput(new BaseParticipant(event.producerId), item);
          },
        },
      },
      {
        specification: new ModelAnswered(),
        processor: {
          apply: ({ event, participant }) => {
            const answer = (event.payload as { answer?: ModelMessageItem }).answer;
            if (!answer) {
              return;
            }
            if (event.producerId === participant.getId()) {
              this.onModelMessage(answer);
              return;
            }
            this.onExternalModelMessage();
          },
        },
      },
      {
        specification: new CustomEventFromOthers(),
        processor: {
          apply: ({ event }) => {
            this.onExternalEvent(new BaseParticipant(event.producerId), event);
          },
        },
      },
    ];
  }
}
