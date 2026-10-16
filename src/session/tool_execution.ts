import { AsyncLocalStorage } from "node:async_hooks";
/** Associates a durable background launch with the exact tool intent across async dispatch. */
export const toolExecution = new AsyncLocalStorage<{
    scope: string;
    id: string;
}>();
