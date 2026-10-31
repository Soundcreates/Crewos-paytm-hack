import {EmployeeEmblem} from './EmployeeEmblem.jsx';
import {NavIcon} from './ui.jsx';

const employee = {id: 'crewos-example-analyst', name: 'Research analyst', avatar: 'RA'};
export function WorkExample({stage = 3, className = ''}) {
  return <div className={'work-example ' + className} aria-hidden="true">
    <div className="example-role"><EmployeeEmblem employee={employee} size="large"/><div><b>Research analyst</b><span>Strategy & research</span></div><span className="example-label">Example</span></div>
    <div className="example-sheet">
      <div className="example-sheet-top"><span>{['Request', 'Review', 'Action', 'Result'][stage]}</span><NavIcon name={stage === 3 ? 'check' : stage === 1 ? 'probation' : 'tasks'}/></div>
      <h3>{['Turn this support report into a Jira issue.', 'Review the proposed Jira issue.', 'Create the approved issue.', 'Issue created. Evidence attached.'][stage]}</h3>
      <p>{['Include the reported login errors and steps to reproduce.', 'Check the title and description before the action runs.', 'The employee uses its granted tool after the policy check.', 'CrewOS reads the issue back and checks it against the request.'][stage]}</p>
      <div className="example-lines"><i/><i/><i/></div>
      <div className={'example-artifact ' + (stage === 3 ? 'complete' : '')}><NavIcon name={stage === 3 ? 'check' : 'integrations'}/><div><b>{stage === 3 ? 'Verified Jira result' : stage === 1 ? 'Waiting for your decision' : 'Jira issue'}</b><span>{stage === 3 ? 'Linked to the original request' : 'Title · description · project'}</span></div><span aria-hidden="true">↗</span></div>
    </div>
    <div className="example-paper-edge"/>
  </div>;
}
