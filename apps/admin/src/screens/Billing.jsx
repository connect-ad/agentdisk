import React from 'react';
import { staffApi } from '../api.js';
import { useResource } from '../lib/useResource.js';
import { EmptyState, ErrorState, Skeleton } from '../components/States.jsx';
import { count, date, money, planLabel } from '../lib/format.js';
import {
  billingTone,
  card,
  dataRow,
  ellipsis,
  headRow,
  mono,
  paneIn,
  pills,
  statusCell,
  statusDot,
  th,
  thR
} from '../lib/ui.js';

/**
 * Billing, per organization.
 *
 * ── The grain is the correction ────────────────────────────────────────────
 * The design draws MRR as a column on the workspace table. Billing attaches to
 * `organizations.stripe_customer_id`, one organization owns many workspaces,
 * and a per-workspace MRR would have to invent a split the product never
 * performs. This is the org table instead.
 *
 * ── No card details, ever ──────────────────────────────────────────────────
 * The design has a brand and last-4 column. We are deliberately outside PCI
 * scope — card data never touches our servers and we store nothing about it —
 * so the column cannot be filled without starting to.
 *
 * ── Read-only ──────────────────────────────────────────────────────────────
 * Nothing here mutates Stripe. Refunds, disputes and invoice edits happen in
 * Stripe's own dashboard, which every row links to.
 *
 * ── A failed Stripe read says so ───────────────────────────────────────────
 * Next-invoice needs a live call. When it fails the row still renders with that
 * cell marked unavailable, because a blank reads as "nothing due" and a zero
 * reads as "not paying", and both are claims we would be making up.
 */

const COLS = 'minmax(0,1.4fr) 82px 90px 120px 96px 110px 80px';

const TITLES = {
  all: 'Billing — all organizations',
  past_due: 'Billing — past due',
  canceled: 'Billing — canceled'
};

export function Billing({ filter = 'all' }) {
  const resource = useResource(() => staffApi.billing(filter === 'all' ? undefined : filter), [filter]);

  if (resource.loading) return <Skeleton rows={6} />;
  if (resource.error && !resource.data) {
    return <ErrorState error={resource.error} onRetry={resource.refresh} />;
  }

  const rows = resource.data?.rows ?? [];
  const summary = resource.data?.summary ?? {};

  return (
    <div style={paneIn}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
          gap: '12px',
          marginBottom: '14px'
        }}
      >
        {[
          { label: 'ORGANIZATIONS BILLING', value: count(summary.orgs ?? 0) },
          { label: 'MONTHLY RECURRING', value: money(summary.mrrCents ?? 0) },
          { label: 'PAST DUE', value: count(summary.pastDue ?? 0), tone: summary.pastDue > 0 },
          { label: 'CANCELED', value: count(summary.canceled ?? 0) }
        ].map(tile => (
          <div
            key={tile.label}
            style={{
              border: `1px solid ${tile.tone ? 'var(--warnBd)' : 'var(--bd)'}`,
              background: tile.tone ? 'var(--warnSoft)' : 'var(--surf)',
              borderRadius: '11px',
              padding: '13px'
            }}
          >
            <div
              style={{
                ...mono,
                fontSize: '9px',
                letterSpacing: '0.11em',
                color: tile.tone ? 'var(--warnTx)' : 'var(--tx3)',
                marginBottom: '8px'
              }}
            >
              {tile.label}
            </div>
            <span
              style={{
                fontFamily: 'var(--fontHead)',
                fontSize: '24px',
                fontWeight: 600,
                letterSpacing: '-0.03em',
                color: tile.tone ? 'var(--warnTx)' : 'var(--tx)'
              }}
            >
              {tile.value}
            </span>
          </div>
        ))}
      </div>

      {summary.partial && (
        <div
          style={{
            border: '1px solid var(--warnBd)',
            background: 'var(--warnSoft)',
            borderRadius: '10px',
            padding: '10px 13px',
            marginBottom: '14px',
            fontSize: '12.5px',
            color: 'var(--warnTx)'
          }}
        >
          Stripe could not be reached for at least one organization. Those rows show
          &ldquo;unavailable&rdquo; rather than a number — the totals above are from our own
          records and are complete.
        </div>
      )}

      {rows.length === 0 ? (
        <EmptyState
          title={
            filter === 'past_due'
              ? 'Nothing is past due'
              : filter === 'canceled'
                ? 'No cancelled subscriptions'
                : 'No organization has a Stripe customer yet'
          }
          detail={
            filter === 'all'
              ? 'An organization appears here once it has been through checkout at least once.'
              : undefined
          }
        />
      ) : (
        <div style={card}>
          <div style={{ overflowX: 'auto' }}>
            <div style={{ minWidth: '880px' }}>
              <div style={headRow(COLS)}>
                <span style={th}>Organization</span>
                <span style={th}>Plan</span>
                <span style={thR}>MRR</span>
                <span style={th}>Next invoice</span>
                <span style={thR}>Workspaces</span>
                <span style={th}>Status</span>
                <span style={th}>Stripe</span>
              </div>
              {rows.map(row => (
                <div key={row.orgId} style={dataRow(COLS, false)}>
                  <span style={{ minWidth: 0 }}>
                    <span
                      style={{
                        display: 'block',
                        fontSize: '12.5px',
                        fontWeight: 500,
                        color: 'var(--tx)',
                        ...ellipsis
                      }}
                    >
                      {row.orgName}
                    </span>
                    <span style={{ ...mono, display: 'block', fontSize: '10.5px', color: 'var(--tx3)', ...ellipsis }}>
                      {row.ownerEmail ?? 'owner row missing'}
                    </span>
                  </span>
                  <span style={pills.accent}>{planLabel(row.plan)}</span>
                  <span style={{ ...mono, fontSize: '11.5px', color: 'var(--tx)', textAlign: 'right' }}>
                    {money(row.mrrCents ?? 0)}
                  </span>
                  <span style={{ fontSize: '12px', color: 'var(--tx2)', ...ellipsis }}>
                    {row.stripeUnavailable ? (
                      <span style={{ ...mono, fontSize: '11px', color: 'var(--tx3)', fontStyle: 'italic' }}>
                        unavailable
                      </span>
                    ) : row.nextInvoiceAt ? (
                      date(row.nextInvoiceAt)
                    ) : (
                      '—'
                    )}
                  </span>
                  <span style={{ ...mono, fontSize: '11.5px', color: 'var(--tx2)', textAlign: 'right' }}>
                    {count(row.workspaces)}
                  </span>
                  <span style={statusCell(billingTone(row.billingStatus))}>
                    <span style={statusDot(billingTone(row.billingStatus))} />
                    {row.billingStatus}
                  </span>
                  {/*
                    Out to Stripe, because that is where a refund or a dispute is
                    actually handled. Rebuilding it here would mean
                    reimplementing a compliance-sensitive workflow with none of
                    the controls Stripe already has.
                  */}
                  <a
                    href={`https://dashboard.stripe.com/customers/${row.stripeCustomerId}`}
                    target="_blank"
                    rel="noreferrer noopener"
                    style={{ fontSize: '12px', color: 'var(--acc)' }}
                  >
                    Open ↗
                  </a>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export { TITLES as BILLING_TITLES };
