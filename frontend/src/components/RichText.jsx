import Markdown from 'react-markdown';
import {safeUrl} from '../lib/content.js';
export default function RichText({children}){return <div className="rich-text"><Markdown skipHtml components={{a:({href,children})=>{const url=safeUrl(href);return url?<a href={url} target="_blank" rel="noopener noreferrer">{children}</a>:<span>{children}</span>;},img:()=>null}}>{String(children||'')}</Markdown></div>;}
