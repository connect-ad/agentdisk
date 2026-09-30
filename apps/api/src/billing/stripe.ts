/**
 * The Stripe client, configured for Workers — 14 PART 29.
 *
 * Two things are not optional here and both are Workers-specific. The SDK's
 * default HTTP client uses Node's `http` module, which does not exist in this
 * runtime; and its default crypto provider uses Node's `crypto`, which the
 * webhook signature check needs and also does not exist. Stripe ships a fetch
 * client and a SubtleCrypto provider for exactly this, and without both the
 * failure is at runtime rather than at build.
 *
 * The signature check uses the SDK's own `constructEventAsync` rather than a
 * hand-rolled HMAC comparison, on doc 29.3's explicit instruction. That is not
 * deference for its own sake: a subtly wrong verification here accepts forged
 * events, and a forged `invoice.payment_succeeded` is somebody using the
 * product for free.
 */

import Stripe from "stripe";

/** Reused across requests in one isolate; constructing it per call is waste. */
let cached: { key: string; client: Stripe } | null = null;

export function stripeClient(secretKey: string): Stripe {
  if (cached !== null && cached.key === secretKey) return cached.client;

  const client = new Stripe(secretKey, {
    httpClient: Stripe.createFetchHttpClient(),
    // Pinning the version means a Stripe-side upgrade cannot silently change
    // the shape of an event this code already handles.
    apiVersion: "2026-08-26.dahlia",
    // One retry, because a webhook Stripe will re-deliver anyway does not need
    // an aggressive retry budget on our side.
    maxNetworkRetries: 1,
  });

  cached = { key: secretKey, client };
  return client;
}

/**
 * Verify a webhook and return the event.
 *
 * Throws on a bad signature, which the caller turns into a 400. Stripe treats
 * any non-2xx as a delivery failure and retries with backoff, so refusing a
 * forged event costs nothing and refusing a genuine one we mishandled gets a
 * second chance.
 */
export async function constructEvent(
  client: Stripe,
  payload: string,
  signature: string,
  webhookSecret: string
): Promise<Stripe.Event> {
  return client.webhooks.constructEventAsync(
    payload,
    signature,
    webhookSecret,
    undefined,
    Stripe.createSubtleCryptoProvider()
  );
}

export type { Stripe };
