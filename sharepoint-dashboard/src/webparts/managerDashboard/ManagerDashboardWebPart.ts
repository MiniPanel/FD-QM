import { Version } from '@microsoft/sp-core-library';
import { BaseClientSideWebPart } from '@microsoft/sp-webpart-base';
import { SPHttpClient } from '@microsoft/sp-http';
import * as React from 'react';
import * as ReactDom from 'react-dom';
import ManagerDashboard from './components/ManagerDashboard';

export interface IManagerDashboardWebPartProps { listName: string; }

export default class ManagerDashboardWebPart extends BaseClientSideWebPart<IManagerDashboardWebPartProps> {
  public render(): void {
    const element = React.createElement(ManagerDashboard, {
      context: this.context,
      listName: this.properties.listName || 'CDAX Follow-up Cases'
    });
    ReactDom.render(element, this.domElement);
  }
  protected get dataVersion(): Version { return Version.parse('1.0'); }
  protected getPropertyPaneConfiguration() {
    return {
      pages: [{
        header: { description: 'Read-only CDAX case dashboard settings' },
        groups: [{ groupName: 'SharePoint list', groupFields: [] }]
      }]
    };
  }
}
