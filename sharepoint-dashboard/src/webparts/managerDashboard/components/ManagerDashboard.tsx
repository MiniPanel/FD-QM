import * as React from 'react';
import { SPHttpClient, SPHttpClientResponse } from '@microsoft/sp-http';
import { WebPartContext } from '@microsoft/sp-webpart-base';
import './ManagerDashboard.css';

interface ICaseRow {
  Id: number; Title?: string; incidentId?: string; customer?: string; queueName?: string; owner?: string;
  automationStatus?: string; followupsSent?: number; followupsPlanned?: number; inQueue?: boolean;
  responseDetected?: boolean; newContactDetected?: boolean; lastUpdated?: string; lastAction?: string;
}
interface IProps { context: WebPartContext; listName: string; }
interface IState { rows: ICaseRow[]; loading: boolean; error: string; query: string; filter: string; refreshedAt?: Date; }
const FILTERS = [
  { key: 'all', label: 'All cases', color: 'blue' },
  { key: 'inqueue', label: 'In queue', color: 'cyan' },
  { key: 'progress', label: 'Follow-ups in progress', color: 'purple' },
  { key: 'responded', label: 'Customer responded', color: 'green' },
  { key: 'newcontact', label: 'New chat / call', color: 'orange' },
  { key: 'ready', label: 'Ready for closure', color: 'red' }
];
const esc = (s: string): string => s.replace(/'/g, "''");

export default class ManagerDashboard extends React.Component<IProps, IState> {
  private timer?: number;
  public state: IState = { rows: [], loading: true, error: '', query: '', filter: 'all' };

  public componentDidMount(): void { this.load(); this.timer = window.setInterval(() => this.load(), 60000); }
  public componentWillUnmount(): void { if (this.timer) window.clearInterval(this.timer); }

  private async load(): Promise<void> {
    try {
      const siteUrl = this.props.context.pageContext.web.absoluteUrl;
      const list = esc(this.props.listName);
      const url = `${siteUrl}/_api/web/lists/getbytitle('${list}')/items?$select=Id,Title,incidentId,customer,queueName,owner,automationStatus,followupsSent,followupsPlanned,inQueue,responseDetected,newContactDetected,lastUpdated,lastAction&$top=5000&$orderby=Modified desc`;
      const response: SPHttpClientResponse = await this.props.context.spHttpClient.get(url, SPHttpClient.configurations.v1, { headers: { Accept: 'application/json;odata=nometadata' } });
      if (!response.ok) throw new Error(`Could not read the SharePoint list (${response.status}). Check the list name and your View permission.`);
      const data = await response.json();
      this.setState({ rows: data.value || [], loading: false, error: '', refreshedAt: new Date() });
    } catch (e) {
      this.setState({ loading: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  private matches(row: ICaseRow, key: string): boolean {
    const status = (row.automationStatus || '').toLowerCase();
    switch (key) {
      case 'inqueue': return !!row.inQueue;
      case 'progress': return ['active', 'paused', 'waactive'].indexOf(status) >= 0;
      case 'responded': return !!row.responseDetected;
      case 'newcontact': return !!row.newContactDetected;
      case 'ready': return status === 'ready';
      default: return true;
    }
  }

  private visibleRows(): ICaseRow[] {
    const q = this.state.query.trim().toLowerCase();
    return this.state.rows.filter(row => this.matches(row, this.state.filter) && (!q || [row.Title, row.customer, row.queueName, row.owner, row.automationStatus].join(' ').toLowerCase().indexOf(q) >= 0));
  }

  public render(): React.ReactElement {
    const rows = this.visibleRows();
    const stamp = this.state.refreshedAt ? this.state.refreshedAt.toLocaleTimeString() : '—';
    return <main className="managerDash">
      <header className="mdHeader"><div><div className="mdEyebrow">CDAX FOLLOW-UP AUTOMATION</div><h1>Case overview</h1><p>Read-only status dashboard</p></div><div className="mdUpdated"><span className="mdLiveDot"/> SharePoint data · refreshed {stamp}<button onClick={() => this.load()} aria-label="Refresh cases">Refresh</button></div></header>
      {this.state.error && <div className="mdError" role="alert">{this.state.error}</div>}
      <section className="mdCards" aria-label="Filter cases by status">{FILTERS.map(card => <button key={card.key} className={`mdCard ${card.color} ${this.state.filter === card.key ? 'selected' : ''}`} onClick={() => this.setState({ filter: card.key })} aria-pressed={this.state.filter === card.key}><span>{card.label}</span><strong>{this.state.rows.filter(row => this.matches(row, card.key)).length}</strong></button>)}</section>
      <section className="mdTablePanel"><div className="mdTableHead"><div><h2>{FILTERS.find(x => x.key === this.state.filter)!.label}</h2><p>{rows.length} case{rows.length === 1 ? '' : 's'}</p></div><input type="search" value={this.state.query} onChange={e => this.setState({ query: e.currentTarget.value })} placeholder="Search case, customer, owner…" aria-label="Search cases"/></div>
        <div className="mdTableScroll"><table><thead><tr><th>Case</th><th>Customer</th><th>Queue</th><th>Owner</th><th>Follow-ups</th><th>Status</th><th>Last updated</th></tr></thead><tbody>
          {rows.map(row => <tr key={row.incidentId || row.Id}><td className="mdCase">{row.Title || row.incidentId || '—'}</td><td>{row.customer || '—'}</td><td>{row.queueName || '—'}</td><td>{row.owner || '—'}</td><td>{Number(row.followupsSent || 0)} / {Number(row.followupsPlanned || 2)}</td><td><span className={`mdStatus ${String(row.automationStatus || 'waiting').toLowerCase()}`}>{this.statusLabel(row)}</span></td><td>{row.lastUpdated ? new Date(row.lastUpdated).toLocaleString() : '—'}</td></tr>)}
          {!this.state.loading && rows.length === 0 && <tr><td className="mdEmpty" colSpan={7}>No cases match this view.</td></tr>}
          {this.state.loading && <tr><td className="mdEmpty" colSpan={7}>Loading cases…</td></tr>}
        </tbody></table></div></section>
      <footer className="mdFooter">Read-only view · Case data is refreshed from the SharePoint list every minute.</footer>
    </main>;
  }

  private statusLabel(row: ICaseRow): string {
    if (row.newContactDetected) return 'New chat / call';
    const labels: { [key: string]: string } = { active: 'In progress', paused: 'Paused', ready: 'Ready for closure', responded: 'Customer responded', removed: 'Removed from queue', noemail: 'No email address', error: 'Error', stopped: 'Stopped', waactive: 'WhatsApp active', none: 'Waiting to start' };
    const key = String(row.automationStatus || 'none').toLowerCase();
    return labels[key] || key;
  }
}
