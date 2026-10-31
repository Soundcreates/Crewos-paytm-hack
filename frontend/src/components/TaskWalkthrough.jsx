import {useRef} from 'react';
import gsap from 'gsap';
import {ScrollTrigger} from 'gsap/ScrollTrigger';
import {useGSAP} from '@gsap/react';
import {WorkExample} from './WorkExample.jsx';

gsap.registerPlugin(useGSAP,ScrollTrigger);
const steps=[
  {title:'Assign the task',text:'Ask an employee to turn a support report into a Jira issue, including the login errors and steps to reproduce.'},
  {title:'Review the proposed action',text:'When a workspace rule requires approval, you review the exact title, description, and project before the issue is created.'},
  {title:'Let the employee carry it out',text:'The employee uses its granted Jira tool after the policy check. You can follow the recorded action as it runs.'},
  {title:'Check what was delivered',text:'CrewOS reads the created issue back, verifies it against the request, and attaches the evidence to the result.'},
];
export default function TaskWalkthrough(){
  const root=useRef(null);
  useGSAP(()=>{
    const media=gsap.matchMedia();
    media.add('(min-width:1024px) and (min-height:740px) and (prefers-reduced-motion:no-preference)',()=>{
      const panels=gsap.utils.toArray('[data-example-stage]',root.current);
      gsap.set(panels,{opacity:0,y:8});
      gsap.set(panels[0],{opacity:1,y:0});
      gsap.set('.walkthrough-progress',{scaleY:0});
      const timeline=gsap.timeline({defaults:{ease:'none'},scrollTrigger:{trigger:'.walkthrough-record',start:'top 55%',end:'bottom 90%',scrub:true,invalidateOnRefresh:true}});
      timeline.to('.walkthrough-progress',{scaleY:1,duration:3.2},0);
      panels.slice(1).forEach((panel,index)=>{
        timeline.to(panels[index],{opacity:0,y:-8,duration:.22},index+.6)
          .to(panel,{opacity:1,y:0,duration:.3},index+.7);
      });
    });
    let active=true,frame;
    const refresh=()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(()=>{if(active)ScrollTrigger.refresh();});};
    document.fonts?.ready.then(refresh);
    const observer=new ResizeObserver(refresh);
    observer.observe(root.current);
    return()=>{active=false;cancelAnimationFrame(frame);observer.disconnect();media.revert();};
  },{scope:root});
  return <section ref={root} className="walkthrough"><div className="walkthrough-title"><h2>From a request<br/>to a checked result<span className="accent-dot">.</span></h2><p>Follow one task through the moments where you stay in control.</p><div className="walkthrough-preview">{steps.map((step,index)=><div className="work-example-stage" data-example-stage key={step.title}><WorkExample stage={index}/></div>)}</div></div><div className="walkthrough-steps"><div className="walkthrough-record"><div className="walkthrough-progress" aria-hidden="true"/>{steps.map((step,index)=><article key={step.title}><span aria-hidden="true">{index+1}</span><h3>{step.title}</h3><p>{step.text}</p></article>)}</div></div></section>;
}
