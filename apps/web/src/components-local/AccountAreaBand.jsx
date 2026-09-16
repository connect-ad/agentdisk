import React from 'react';
import { Icon } from '../components/index.js';

/**
 * The account-area band, from `AgentDisk Dashboard.dc.html`.
 *
 * It takes the place of the workspace info strip on Account, Billing and
 * Contact Support, and it is accent-tinted rather than the strip's neutral
 * grey for one reason: those three screens are about the person and the
 * organization, not about the workspace whose name is still sitting in the
 * switcher above. Without the swap, the strip goes on announcing a workspace
 * ID and plan beside a page that has nothing to do with either — which is how
 * somebody comes to believe they are editing one workspace's billing.
 *
 * `label` names where you are, so the band says which of the three you are on
 * without depending on the heading below it having been read.
 */
export default function AccountAreaBand({ label, onBack }) {
  return (
    <div className="acctband">
      <div className="acctband__inner">
        <button type="button" className="acctband__back" onClick={onBack}>
          <Icon name="chevronLeft" size={14} />
          Back to workspace
        </button>
        <span className="acctband__where">ACCOUNT AREA · {label}</span>
      </div>
    </div>
  );
}
