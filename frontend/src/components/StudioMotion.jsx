import {m, useReducedMotion} from 'motion/react';

export function Reveal({children, className = '', delay = 0}) {
  const reduced = useReducedMotion();
  return <m.div className={className} initial={reduced ? false : {opacity: 0, y: 8}}
    whileInView={{opacity: 1, y: 0}} viewport={{once: true, amount: .08}}
    transition={{duration: .3, delay, ease: [.22, 1, .36, 1]}}>{children}</m.div>;
}
export function RecordTransition({children, recordId}) {
  const reduced = useReducedMotion();
  return <m.div key={recordId} initial={reduced ? false : {opacity: 0, x: 12}}
    animate={{opacity: 1, x: 0}} transition={{duration: reduced ? .1 : .24, ease: [.22, 1, .36, 1]}}>{children}</m.div>;
}
