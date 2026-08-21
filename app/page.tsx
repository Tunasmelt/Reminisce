'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import Link from 'next/link'
import dynamic from 'next/dynamic'
import {
  Bot, Sparkles, GitBranch, FolderSync,
  Zap, Network, Users, ArrowRight, Check,
  FileCode2, Database,
  BookOpen, FlaskConical,
} from 'lucide-react'
import { useTheme } from '@/hooks/useTheme'
import LandingNav from '@/components/landing-nav'
import ReminisceLogo from '@/components/ReminisceLogo'

const Scene3D = dynamic(() => import('@/components/Scene3D'), { ssr: false, loading: () => null })
const BentoScene = dynamic(() => import('@/components/BentoScene'), { ssr: false, loading: () => null })

function hexToRgba(hex: string, a: number) {
  if (!hex || hex.length < 7) return `rgba(245,158,11,${a})`
  const r = parseInt(hex.slice(1,3),16)
  const g = parseInt(hex.slice(3,5),16)
  const b = parseInt(hex.slice(5,7),16)
  return `rgba(${r},${g},${b},${a})`
}

function useScrollReveal() {
  useEffect(() => {
    const io = new IntersectionObserver(
      entries => entries.forEach(e => { if (e.isIntersecting) e.target.classList.add('sr-vis') }),
      { threshold: 0.06 }
    )
    document.querySelectorAll('.sr').forEach(el => io.observe(el))
    return () => io.disconnect()
  }, [])
}

function CountUp({ value, suffix = '' }: { value: string; suffix?: string }) {
  const ref   = useRef<HTMLSpanElement>(null)
  const fired = useRef(false)
  useEffect(() => {
    const num = parseFloat(value.replace(/[^0-9.]/g, ''))
    if (isNaN(num)) return
    const io = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting || fired.current) return
      fired.current = true
      let start = 0
      const step = (ts: number) => {
        if (!start) start = ts
        const p = Math.min((ts - start) / 1800, 1)
        const ease = 1 - Math.pow(1 - p, 3)
        if (ref.current) ref.current.textContent = Math.floor(ease * num).toString() + suffix
        if (p < 1) requestAnimationFrame(step)
      }
      requestAnimationFrame(step)
    }, { threshold: 0.5 })
    if (ref.current) io.observe(ref.current)
    return () => io.disconnect()
  }, [value, suffix])
  return <span ref={ref}>0{suffix}</span>
}

function FloatingRing({ accent, size = 120, opacity = 0.18, delay = '0s' }: {
  accent: string; size?: number; opacity?: number; delay?: string
}) {
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%',
      border: `1.5px solid ${hexToRgba(accent, opacity)}`,
      boxShadow: `0 0 ${size * 0.3}px ${hexToRgba(accent, opacity * 0.5)}`,
      animation: `ring-float 6s ease-in-out ${delay} infinite`,
      pointerEvents: 'none', flexShrink: 0,
    }}/>
  )
}

function ThreeDCard({
  children, style, onMouseEnter, onMouseLeave, className,
}: {
  children: React.ReactNode
  style?: React.CSSProperties
  onMouseEnter?: () => void
  onMouseLeave?: () => void
  className?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [tilt, setTilt] = useState({ x: 0, y: 0 })
  const [hovered, setHovered] = useState(false)
  const handleMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!ref.current) return
    const rect = ref.current.getBoundingClientRect()
    setTilt({
      x: ((e.clientY - rect.top - rect.height / 2) / rect.height) * 8,
      y: -((e.clientX - rect.left - rect.width / 2) / rect.width) * 8,
    })
  }, [])
  const handleLeave = useCallback(() => {
    setTilt({ x: 0, y: 0 }); setHovered(false); onMouseLeave?.()
  }, [onMouseLeave])
  const handleEnter = useCallback(() => {
    setHovered(true); onMouseEnter?.()
  }, [onMouseEnter])
  return (
    <div
      ref={ref} className={className}
      onMouseMove={handleMove} onMouseEnter={handleEnter} onMouseLeave={handleLeave}
      style={{
        transform: `perspective(1000px) rotateX(${tilt.x}deg) rotateY(${tilt.y}deg)`,
        transition: hovered
          ? 'transform 0.1s ease, border-color 0.3s ease, box-shadow 0.3s ease'
          : 'transform 0.5s cubic-bezier(0.23,1,0.32,1), border-color 0.5s ease, box-shadow 0.5s ease',
        position: 'relative', overflow: 'hidden',
        boxShadow: hovered ? `0 20px 48px rgba(0,0,0,0.5), 0 0 24px ${hexToRgba(style?.borderColor as string || '#fff', 0.15)}` : 'none',
        ...style,
        borderColor: hovered ? hexToRgba(style?.borderColor as string || '#fff', 0.5) : style?.borderColor,
      }}
    >
      <div style={{ position:'absolute', inset:0, background:'linear-gradient(135deg,rgba(255,255,255,0.04) 0%,transparent 60%)', opacity:hovered?1:0, transition:'opacity 0.3s', pointerEvents:'none', zIndex:1 }}/>
      <div style={{ position:'relative', zIndex:2, height:'100%' }}>{children}</div>
    </div>
  )
}

export default function LandingPage() {
  const { accent } = useTheme()
  const ac = accent || '#f59e0b'
  const [scrollY, setScrollY] = useState(0)
  const [mobile, setMobile] = useState(false)
  useScrollReveal()

  useEffect(() => {
    const r = () => setMobile(window.innerWidth < 768)
    r(); window.addEventListener('resize', r)
    return () => window.removeEventListener('resize', r)
  }, [])

  useEffect(() => {
    const s = () => setScrollY(window.scrollY)
    window.addEventListener('scroll', s, { passive: true })
    return () => window.removeEventListener('scroll', s)
  }, [])


  const heroFade = Math.max(0, 1 - scrollY / 500)
  const heroUp   = scrollY * 0.18

  const features = [
    { icon: Sparkles,    tag: 'Onboarding', size: 'large', title: 'Project Wizard', desc: 'A 4-stage AI conversation that generates your entire project blueprint, tech stack, and feature roadmap in minutes.', bullets: ['Parallel wave generation', 'GitHub repo enrichment', 'Editor file auto-generation'] },
    { icon: Database,   tag: 'Core',        size: 'large', title: 'Context Engine', desc: 'Versioned markdown store injected into every AI call. Your agent never forgets an architecture decision.', bullets: ['Version history on every file', 'Bidirectional local sync', 'Reminisce vs developer ownership'] },
    { icon: Bot,        tag: 'AI',          size: 'medium', title: 'AI Agent', desc: 'Pick a feature, pick a model, hit run. Full project context per call. Run history and git branch logged.', bullets: ['12+ models across 6 providers', 'Auto-logs to agent-runs.md', 'BYOK for all providers'] },
    { icon: Zap,        tag: 'AI',          size: 'medium', title: 'PAM', desc: 'Project Action Manager — ask about progress, mark features done, generate prompts, all via chat.' },
    { icon: GitBranch,  tag: 'Git',         size: 'small',  title: 'Git Integration', desc: 'Reads your local .git/ directly. Branch and commit surface in PAM — no API calls.' },
    { icon: FolderSync, tag: 'Sync',        size: 'small',  title: 'Local Sync', desc: 'Connect your project folder. Reminisce writes context files to disk. Changes sync back on focus return.' },
    { icon: FileCode2,  tag: 'Editors',     size: 'small',  title: 'Editor Files', desc: 'Auto-generates .cursorrules, CLAUDE.md, or copilot-instructions.md so every session starts with full context.' },
    { icon: Network,    tag: 'Visual',      size: 'small',  title: 'Graph View', desc: 'Visual map of every phase and feature with live status, drag-and-drop, and canvas annotations.' },
    { icon: BookOpen,   tag: 'Prompts',     size: 'small',  title: 'Prompt Library', desc: 'Three-tab archive: Blueprint prompts, custom prompts, and auto-populated changelog.' },
    { icon: FlaskConical, tag: 'Testing',   size: 'small',  title: 'API Lab', desc: 'Built-in HTTP client for endpoint testing with method selector, auth, headers, and response inspector.' },
    { icon: Users,      tag: 'Team',        size: 'small',  title: 'Collaboration', desc: 'Invite up to 7 members. Everyone works from the same live context, blueprint, and board.' },
  ]

  const bentoLayout = [
    { fi: 0,  col: '1 / 7',  row: '1 / 3' },
    { fi: 1,  col: '7 / 13', row: '1 / 3' },
    { fi: 2,  col: '1 / 7',  row: '3 / 4' },
    { fi: 3,  col: '7 / 13', row: '3 / 4' },
    { fi: 4,  col: '1 / 4',  row: '4 / 5' },
    { fi: 5,  col: '4 / 7',  row: '4 / 5' },
    { fi: 6,  col: '7 / 10', row: '4 / 5' },
    { fi: 7,  col: '10 / 13',row: '4 / 5' },
    { fi: 8,  col: '1 / 4',  row: '5 / 6' },
    { fi: 9,  col: '4 / 7',  row: '5 / 6' },
    { fi: 10, col: '7 / 10', row: '5 / 6' },
  ]

  const stats = [
    { val: '12', suf: '+', label: 'AI Models' },
    { val: '50', suf: 'ms', label: 'Injection Speed' },
    { val: '∞', suf: '', label: 'Memory' },
    { val: '0', suf: '', label: 'Repetition' },
  ]

  return (
    <div style={{ background: '#05050f', color: '#fff', minHeight: '100vh', overflowX: 'hidden' }}>
      <style suppressHydrationWarning dangerouslySetInnerHTML={{ __html: `
        .sr{opacity:0;transform:translateY(32px);transition:opacity .8s ease,transform .8s ease}
        .sr-vis{opacity:1;transform:translateY(0)}
        .d1{transition-delay:.05s}.d2{transition-delay:.12s}.d3{transition-delay:.19s}
        .d4{transition-delay:.26s}.d5{transition-delay:.33s}
        @keyframes badge-float{0%,100%{transform:translateY(0)}50%{transform:translateY(-5px)}}
        @keyframes ring-float{0%,100%{transform:translateY(0) rotate(0deg)}50%{transform:translateY(-10px) rotate(6deg)}}
        @keyframes scanline{0%{transform:translateY(-4px);opacity:0}5%{opacity:1}95%{opacity:1}100%{transform:translateY(300px);opacity:0}}
        @keyframes orb-drift{0%,100%{transform:translate(0,0) scale(1)}33%{transform:translate(30px,-20px) scale(1.04)}66%{transform:translate(-20px,15px) scale(0.97)}}
        @keyframes sync-bar{0%{transform:translateX(-100%)}100%{transform:translateX(400%)}}
        @keyframes scroll-line{0%,100%{opacity:0.3;transform:scaleY(0.6)}50%{opacity:1;transform:scaleY(1)}}
        @keyframes pulse-ring{0%{transform:scale(1);opacity:0.6}100%{transform:scale(1.6);opacity:0}}
        .feature-card:hover{border-color:${hexToRgba(ac,0.3)}!important;transform:translateY(-4px);background:${hexToRgba(ac,0.04)}!important}
        .feature-card{transition:all 0.25s ease}
        .glow-btn:hover{box-shadow:0 0 32px ${hexToRgba(ac,0.4)};transform:translateY(-2px)}
        .glow-btn{transition:all 0.2s ease}
      ` }} />

      {/* Fixed radial top glow */}
      <div style={{ position:'fixed', top:-240, left:'50%', transform:'translateX(-50%)', width:900, height:560, background:`radial-gradient(ellipse,${hexToRgba(ac,0.14)} 0%,transparent 68%)`, pointerEvents:'none', zIndex:0 }}/>

      <LandingNav />

      {/* ══════════════════════════════════════════ HERO */}
      <section style={{ position:'relative', height:'100vh', display:'flex', alignItems:'center', justifyContent:'center', overflow:'hidden' }}>
        <div style={{ position:'absolute', inset:0, opacity:heroFade, transition:'opacity .1s linear' }}>
          <Scene3D accent={ac} />
        </div>

        {!mobile && (
          <>
            <div style={{ position:'absolute', top:'18%', left:'8%', pointerEvents:'none' }}>
              <FloatingRing accent={ac} size={180} opacity={0.12} delay="0s" />
            </div>
            <div style={{ position:'absolute', top:'55%', right:'7%', pointerEvents:'none' }}>
              <FloatingRing accent={ac} size={120} opacity={0.09} delay="2s" />
            </div>
            <div style={{ position:'absolute', bottom:'12%', left:'22%', pointerEvents:'none' }}>
              <FloatingRing accent={ac} size={80} opacity={0.07} delay="4s" />
            </div>
          </>
        )}

        <div style={{ position:'absolute', top:'50%', left:'50%', transform:'translate(-50%,-50%)', width:720, height:720, background:`radial-gradient(ellipse,${hexToRgba(ac,0.14)} 0%,transparent 60%)`, pointerEvents:'none' }}/>

        <div style={{ position:'relative', zIndex:2, textAlign:'center', padding:mobile?'0 24px':'0 48px', maxWidth:760, transform:`translateY(${heroUp}px)` }}>
          <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:14, marginBottom:24 }}>
            <ReminisceLogo size={mobile?56:72} color="#ffffff" glowColor={hexToRgba(ac,0.55)} />
          </div>
          <div style={{ display:'inline-flex', alignItems:'center', gap:8, background:hexToRgba(ac,0.1), border:`1px solid ${hexToRgba(ac,0.3)}`, borderRadius:999, padding:'5px 16px', fontSize:10, fontWeight:800, letterSpacing:'0.18em', color:ac, textTransform:'uppercase', marginBottom:24, animation:'badge-float 4s ease-in-out infinite' }}>
            <span style={{ width:5, height:5, borderRadius:'50%', background:ac, display:'inline-block' }}/> AI Context Platform for Developers
          </div>
          <h1 style={{ fontSize:mobile?'clamp(30px,9vw,46px)':'clamp(44px,5.5vw,72px)', fontWeight:900, letterSpacing:'-0.03em', lineHeight:1.06, color:'#fff', margin:'0 0 20px' }}>
            Your project context,<br/>
            <span style={{ background:`linear-gradient(135deg,${ac} 0%,#fff 100%)`, WebkitBackgroundClip:'text', WebkitTextFillColor:'transparent', backgroundClip:'text' }}>
              always in the room.
            </span>
          </h1>
          <p style={{ fontSize:mobile?15:18, color:'rgba(255,255,255,0.52)', lineHeight:1.75, maxWidth:560, margin:'0 auto 36px' }}>
            Define your project once. Start from scratch with the Wizard. Every AI call, every editor session, every teammate — working from the same live context.
          </p>
          <div style={{ display:'flex', gap:14, justifyContent:'center', flexWrap:'wrap' }}>
            <Link href="/signup" className="glow-btn" style={{ display:'inline-flex', alignItems:'center', gap:8, background:ac, color:'#000', padding:mobile?'12px 28px':'15px 40px', borderRadius:999, fontSize:14, fontWeight:800, letterSpacing:'0.04em', textDecoration:'none', boxShadow:`0 0 48px ${hexToRgba(ac,0.48)}` }}>
              Start free <ArrowRight size={15}/>
            </Link>
            <Link href="/capabilities" style={{ display:'inline-flex', alignItems:'center', gap:8, background:'rgba(255,255,255,0.07)', border:'1px solid rgba(255,255,255,0.14)', color:'rgba(255,255,255,0.85)', padding:mobile?'12px 28px':'15px 40px', borderRadius:999, fontSize:14, fontWeight:600, textDecoration:'none', backdropFilter:'blur(12px)' }}>
              See all features
            </Link>
          </div>
          <div style={{ marginTop:20, fontSize:11, color:'rgba(255,255,255,0.2)' }}>No credit card · Free forever plan · 50 coins/day</div>
        </div>

        <div style={{ position:'absolute', bottom:32, left:'50%', transform:'translateX(-50%)', display:'flex', flexDirection:'column', alignItems:'center', gap:8, opacity:Math.max(0,1-scrollY/120) }}>
          <span style={{ fontSize:9, letterSpacing:'0.3em', color:'rgba(255,255,255,0.2)', textTransform:'uppercase' }}>scroll</span>
          <div style={{ width:1, height:48, background:`linear-gradient(to bottom,${ac},transparent)`, animation:'scroll-line 2s ease-in-out infinite' }}/>
        </div>
      </section>

      {/* ══════════════════════════════════════════ STATS */}
      <section style={{ padding:mobile?'64px 24px':'96px 60px' }}>
        <div className="sr" style={{ maxWidth:1100, margin:'0 auto' }}>
          <div style={{ display:'grid', gridTemplateColumns:mobile?'repeat(2,1fr)':'repeat(4,1fr)', gap:mobile?1:0, background:'rgba(255,255,255,0.04)', border:'1px solid rgba(255,255,255,0.07)', borderRadius:28, backdropFilter:'blur(20px)', overflow:'hidden' }}>
            {stats.map((s,i) => (
              <div key={i} style={{ display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', padding:mobile?'36px 16px':'48px 24px', borderRight:(!mobile&&i<3)?'1px solid rgba(255,255,255,0.06)':'none', borderBottom:(mobile&&i<2)?'1px solid rgba(255,255,255,0.06)':'none', position:'relative' }}>
                <div style={{ position:'absolute', inset:0, background:`radial-gradient(ellipse at 50% 0%,${hexToRgba(ac,0.06)} 0%,transparent 70%)`, pointerEvents:'none' }}/>
                <div style={{ fontSize:mobile?44:58, fontWeight:900, letterSpacing:'-0.04em', color:'#fff', lineHeight:1, marginBottom:8 }}>
                  {s.val==='∞' ? '∞' : <CountUp value={s.val} suffix={s.suf}/>}
                </div>
                <div style={{ fontSize:10, color:'rgba(255,255,255,0.35)', fontWeight:700, letterSpacing:'0.3em', textTransform:'uppercase', textAlign:'center' }}>{s.label}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ══════════════════════════════════════════ PROBLEM / SOLUTION */}
      <section className="sr" style={{ padding:'clamp(64px,8vw,120px) 24px', maxWidth:1100, margin:'0 auto' }}>
        <div style={{ display:'grid', gridTemplateColumns:mobile?'1fr':'1fr 1fr', gap:2, borderRadius:24, overflow:'hidden', border:'1px solid rgba(255,255,255,0.07)' }}>
          <div style={{ background:'rgba(248,113,113,0.04)', padding:'40px 36px', borderRight:mobile?'none':'1px solid rgba(255,255,255,0.07)', borderBottom:mobile?'1px solid rgba(255,255,255,0.07)':'none' }}>
            <div style={{ fontSize:10, fontWeight:800, letterSpacing:'0.14em', textTransform:'uppercase', color:'#f87171', marginBottom:24 }}>Without Reminisce</div>
            {['Re-explaining your entire project every conversation','AI makes decisions without knowing your architecture','Context pasted manually, gets lost mid-thread','Blueprint generation wastes hours of manual work','Team members have no shared project understanding'].map((t,i) => (
              <div key={i} style={{ display:'flex', gap:12, marginBottom:14, alignItems:'flex-start' }}>
                <span style={{ color:'#f87171', fontSize:16, flexShrink:0, marginTop:1 }}>✗</span>
                <span style={{ fontSize:14, color:'rgba(255,255,255,0.5)', lineHeight:1.5 }}>{t}</span>
              </div>
            ))}
          </div>
          <div style={{ background:hexToRgba(ac,0.04), padding:'40px 36px' }}>
            <div style={{ fontSize:10, fontWeight:800, letterSpacing:'0.14em', textTransform:'uppercase', color:ac, marginBottom:24 }}>With Reminisce</div>
            {['AI knows your stack, phases, and features automatically','Every prompt injected with live project context','Blueprint generated in minutes with the Wizard','Full project intelligence ready for every AI call','Teams share the same project intelligence across every session'].map((t,i) => (
              <div key={i} style={{ display:'flex', gap:12, marginBottom:14, alignItems:'flex-start' }}>
                <Check size={16} style={{ color:ac, flexShrink:0, marginTop:2 }} />
                <span style={{ fontSize:14, color:'rgba(255,255,255,0.8)', lineHeight:1.5 }}>{t}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ══════════════════════════════════════════ BENTO FEATURES */}
      <section style={{ padding:mobile?'64px 24px':'96px 60px 120px', position:'relative', overflow:'hidden' }}>
        {!mobile && (
          <div style={{ position:'absolute', top:0, left:'50%', transform:'translateX(-50%)', width:'100%', height:'100%', opacity:0.07, pointerEvents:'none' }}>
            <BentoScene accent={ac} />
          </div>
        )}
        <div style={{ maxWidth:1280, margin:'0 auto', position:'relative', zIndex:1 }}>
          <div className="sr" style={{ textAlign:'center', marginBottom:mobile?48:80 }}>
            <p style={{ fontSize:10, fontWeight:800, letterSpacing:'0.22em', color:ac, textTransform:'uppercase', marginBottom:16 }}>Platform</p>
            <h2 style={{ fontSize:mobile?28:52, fontWeight:800, letterSpacing:'-0.03em', color:'#fff', marginBottom:16, lineHeight:1.05 }}>Everything in one place.</h2>
            <p style={{ fontSize:mobile?15:18, color:'rgba(255,255,255,0.4)', maxWidth:520, margin:'0 auto', lineHeight:1.7 }}>A unified workspace for persistent project intelligence. From first idea to shipped code.</p>
          </div>

          {mobile ? (
            <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
              {features.map((f,i) => {
                const Icon = f.icon
                return (
                  <ThreeDCard key={i} style={{ padding:'32px 28px', borderRadius:24, background:'rgba(255,255,255,0.03)', border:'1px solid', borderColor:'rgba(255,255,255,0.08)', backdropFilter:'blur(12px)' }}>
                    <div style={{ width:48, height:48, borderRadius:14, background:hexToRgba(ac,0.12), border:`1px solid ${hexToRgba(ac,0.25)}`, display:'flex', alignItems:'center', justifyContent:'center', marginBottom:16 }}>
                      <Icon size={20} color={ac}/>
                    </div>
                    <div style={{ fontSize:10, fontWeight:800, letterSpacing:'0.15em', textTransform:'uppercase', color:ac, marginBottom:8 }}>{f.tag}</div>
                    <h3 style={{ fontSize:16, fontWeight:700, color:'#fff', marginBottom:8 }}>{f.title}</h3>
                    <p style={{ fontSize:13, color:'rgba(255,255,255,0.45)', lineHeight:1.7, margin:0 }}>{f.desc}</p>
                  </ThreeDCard>
                )
              })}
            </div>
          ) : (
            <div style={{ display:'grid', gridTemplateColumns:'repeat(12,1fr)', gridAutoRows:'200px', gap:16 }}>
              {bentoLayout.map(({ fi, col, row }) => {
                const f = features[fi]
                const Icon = f.icon
                const isLarge  = f.size === 'large'
                const isMed    = f.size === 'medium'
                const padding  = isLarge ? '36px' : isMed ? '28px' : '22px'
                const radius   = isLarge ? 28 : 20
                return (
                  <ThreeDCard key={fi} className={`sr d${(fi%3)+1}`} style={{ gridColumn:col, gridRow:row, minHeight:isLarge?416:200, padding, background:'rgba(255,255,255,0.025)', border:'1px solid', borderColor:'rgba(255,255,255,0.07)', borderRadius:radius, display:'flex', flexDirection:'column', backdropFilter:'blur(12px)' }}>
                    {isLarge && (
                      <div style={{ position:'absolute', right:-40, bottom:-40, width:180, height:180, opacity:0.35, pointerEvents:'none' }}>
                        <BentoScene accent={ac} />
                      </div>
                    )}
                    {isMed && (
                      <div style={{ position:'absolute', right:-20, bottom:-20, width:110, height:110, borderRadius:'50%', background:`radial-gradient(ellipse,${hexToRgba(ac,0.22)} 0%,transparent 70%)`, animation:'orb-drift 8s ease-in-out infinite', pointerEvents:'none' }}/>
                    )}
                    {!isLarge && !isMed && (
                      <div style={{ position:'absolute', top:14, right:14, width:7, height:7, borderRadius:'50%', background:hexToRgba(ac,0.4), boxShadow:`0 0 8px ${hexToRgba(ac,0.5)}`, pointerEvents:'none' }}>
                        {(f as {badge?:string}).badge && <span style={{ position:'absolute', right:14, top:-6, fontSize:8, fontWeight:800, padding:'2px 6px', borderRadius:999, background:'rgba(99,102,241,0.15)', color:'#818cf8', border:'1px solid rgba(99,102,241,0.3)', whiteSpace:'nowrap' }}>{(f as {badge?:string}).badge}</span>}
                      </div>
                    )}
                    <div style={{ position:'relative', zIndex:2, flex:1, display:'flex', flexDirection:'column' }}>
                      {isLarge && (f as {badge?:string}).badge && (
                        <span style={{ position:'absolute', top:0, right:0, fontSize:9, fontWeight:800, padding:'3px 10px', borderRadius:999, background:'rgba(99,102,241,0.15)', color:'#818cf8', border:'1px solid rgba(99,102,241,0.3)', letterSpacing:'0.08em' }}>{(f as {badge?:string}).badge}</span>
                      )}
                      <div style={{ width:isLarge?52:42, height:isLarge?52:42, borderRadius:isLarge?16:12, background:hexToRgba(ac,0.1), border:`1px solid ${hexToRgba(ac,0.2)}`, display:'flex', alignItems:'center', justifyContent:'center', marginBottom:isLarge?22:14, flexShrink:0 }}>
                        <Icon size={isLarge?24:19} color={ac}/>
                      </div>
                      <div style={{ fontSize:10, fontWeight:800, letterSpacing:'0.15em', textTransform:'uppercase', color:ac, marginBottom:10 }}>{f.tag}</div>
                      <h3 style={{ fontSize:isLarge?24:isMed?18:14, fontWeight:700, color:'#fff', marginBottom:isLarge?14:8, lineHeight:1.2 }}>{f.title}</h3>
                      <p style={{ fontSize:isLarge?14:13, color:'rgba(255,255,255,0.45)', lineHeight:1.75, margin:0, flex:1 }}>{f.desc}</p>
                      {'bullets' in f && isLarge && (
                        <div style={{ display:'flex', flexDirection:'column', gap:6, marginTop:16 }}>
                          {(f.bullets as string[]).map((b,bi) => (
                            <div key={bi} style={{ display:'flex', alignItems:'center', gap:6, fontSize:12, color:'rgba(255,255,255,0.45)' }}>
                              <Check size={10} color={ac} style={{ flexShrink:0 }}/>{b}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </ThreeDCard>
                )
              })}
            </div>
          )}
        </div>
      </section>


      {/* ══════════════════════════════════════════ MODEL ECOSYSTEM */}
      <section className="sr" style={{ padding:'clamp(64px,8vw,120px) 24px', maxWidth:1100, margin:'0 auto' }}>
        <div style={{ textAlign:'center', marginBottom:48 }}>
          <div style={{ fontSize:10, fontWeight:800, letterSpacing:'0.18em', textTransform:'uppercase', color:ac, marginBottom:12 }}>Model ecosystem</div>
          <h2 style={{ fontSize:'clamp(24px,3.5vw,40px)', fontWeight:900, letterSpacing:'-0.03em', margin:'0 0 16px' }}>Every leading model. Your choice.</h2>
          <p style={{ fontSize:15, color:'rgba(255,255,255,0.4)', maxWidth:480, margin:'0 auto' }}>
            Free tier gives you 50 coins/day across Groq, Cerebras, Gemini, and Mistral. Pro unlocks Claude, GPT-4o, and Gemini 2.5 Pro.
          </p>
        </div>
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(200px,1fr))', gap:10 }}>
          {[
            { name:'Groq',       models:'Llama 3.3 · Gemma 2 · Mixtral',        tier:'Free',     color:'#f59e0b' },
            { name:'Cerebras',   models:'Llama 3.1 · Llama 3.3',                tier:'Free',     color:'#34d399' },
            { name:'Gemini',     models:'2.0 Flash · 1.5 Flash · 2.5 Flash',    tier:'Free+Pro', color:'#60a5fa' },
            { name:'Mistral',    models:'Mistral Small · Large · Codestral',     tier:'Free+Pro', color:'#a78bfa' },
            { name:'OpenRouter', models:'Llama · DeepSeek · Qwen',               tier:'Free',     color:'#fb923c' },
            { name:'Anthropic',  models:'Claude Haiku 4.5 · Sonnet 4',          tier:'Pro',      color:'#f472b6' },
            { name:'OpenAI',     models:'GPT-4o · GPT-4o Mini',                  tier:'Pro',      color:'#818cf8' },
            { name:'BYOK',       models:'Bring your own API key',                tier:'Pro',      color:'#34d399' },
          ].map((m,i) => (
            <div key={i} style={{ padding:'18px', background:'rgba(255,255,255,0.025)', border:'1px solid rgba(255,255,255,0.07)', borderRadius:14 }}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:8 }}>
                <span style={{ fontSize:13, fontWeight:700, color:'#fff' }}>{m.name}</span>
                <span style={{ fontSize:9, fontWeight:800, padding:'2px 8px', borderRadius:999, background:hexToRgba(m.color,0.1), color:m.color, border:`1px solid ${hexToRgba(m.color,0.2)}` }}>{m.tier}</span>
              </div>
              <div style={{ fontSize:11, color:'rgba(255,255,255,0.35)', lineHeight:1.5 }}>{m.models}</div>
            </div>
          ))}
        </div>
      </section>

      {/* ══════════════════════════════════════════ PRICING */}
      <section className="sr" style={{ padding:'clamp(64px,8vw,120px) 24px', maxWidth:900, margin:'0 auto' }}>
        <div style={{ textAlign:'center', marginBottom:64 }}>
          <div style={{ fontSize:10, fontWeight:800, letterSpacing:'0.18em', textTransform:'uppercase', color:ac, marginBottom:12 }}>Pricing</div>
          <h2 style={{ fontSize:'clamp(28px,4vw,44px)', fontWeight:900, letterSpacing:'-0.03em', margin:0 }}>Free to start. Pro when you need it.</h2>
        </div>
        <div style={{ display:'grid', gridTemplateColumns:mobile?'1fr':'1fr 1fr', gap:20 }}>
          <ThreeDCard style={{ background:'rgba(255,255,255,0.025)', border:'1px solid rgba(255,255,255,0.08)', borderColor:'rgba(255,255,255,0.08)', borderRadius:24, padding:'36px 32px' }}>
            <div style={{ fontSize:24, fontWeight:900, color:'#fff', marginBottom:4 }}>Free</div>
            <div style={{ fontSize:32, fontWeight:900, color:'#fff', marginBottom:24 }}>$0 <span style={{ fontSize:14, color:'rgba(255,255,255,0.3)', fontWeight:400 }}>/forever</span></div>
            {['2 projects','50 coins/day (free AI calls)','Wizard + PAM','Graph, Board, Prompts','Local file sync','1 team member'].map((f,i) => (
              <div key={i} style={{ display:'flex', gap:10, marginBottom:12, alignItems:'center' }}>
                <Check size={14} style={{ color:'#34d399', flexShrink:0 }} />
                <span style={{ fontSize:13, color:'rgba(255,255,255,0.6)' }}>{f}</span>
              </div>
            ))}
            <Link href="/signup" style={{ display:'block', textAlign:'center', marginTop:28, padding:'12px', background:'rgba(255,255,255,0.07)', border:'1px solid rgba(255,255,255,0.12)', color:'#fff', borderRadius:999, fontSize:13, fontWeight:700, textDecoration:'none' }}>
              Start free
            </Link>
          </ThreeDCard>
          <ThreeDCard style={{ background:hexToRgba(ac,0.05), border:`1px solid ${hexToRgba(ac,0.25)}`, borderColor:hexToRgba(ac,0.25), borderRadius:24, padding:'36px 32px', position:'relative' }}>
            <div style={{ position:'absolute', top:-1, right:24, fontSize:9, fontWeight:800, padding:'5px 14px', borderRadius:'0 0 10px 10px', background:ac, color:'#000', letterSpacing:'0.1em', textTransform:'uppercase' }}>Most popular</div>
            <div style={{ fontSize:24, fontWeight:900, color:'#fff', marginBottom:4 }}>Pro</div>
            <div style={{ fontSize:32, fontWeight:900, color:'#fff', marginBottom:24 }}>$12 <span style={{ fontSize:14, color:'rgba(255,255,255,0.3)', fontWeight:400 }}>/month</span></div>
            {['Unlimited projects','200 coins/day + 100 gems/month','Claude, GPT-4o, Gemini 2.5 Pro','BYOK — your own API keys','7 team members per project','Semantic memory search','Priority support'].map((f,i) => (
              <div key={i} style={{ display:'flex', gap:10, marginBottom:12, alignItems:'center' }}>
                <Check size={14} style={{ color:ac, flexShrink:0 }} />
                <span style={{ fontSize:13, color:'rgba(255,255,255,0.8)' }}>{f}</span>
              </div>
            ))}
            <Link href="/upgrade" style={{ display:'block', textAlign:'center', marginTop:28, padding:'12px', background:ac, color:'#000', borderRadius:999, fontSize:13, fontWeight:800, textDecoration:'none', boxShadow:`0 0 24px ${hexToRgba(ac,0.3)}` }}>
              Upgrade to Pro →
            </Link>
          </ThreeDCard>
        </div>
      </section>

      {/* ══════════════════════════════════════════ CTA */}
      <section className="sr" style={{ padding:'clamp(64px,8vw,120px) 24px', textAlign:'center' }}>
        <div style={{ maxWidth:640, margin:'0 auto', padding:mobile?'48px 28px':'64px 40px', background:hexToRgba(ac,0.04), border:`1px solid ${hexToRgba(ac,0.15)}`, borderRadius:28 }}>
          <h2 style={{ fontSize:'clamp(28px,4vw,48px)', fontWeight:900, letterSpacing:'-0.03em', margin:'0 0 16px' }}>
            Stop re-explaining.<br/>Start building.
          </h2>
          <p style={{ fontSize:15, color:'rgba(255,255,255,0.45)', marginBottom:36, lineHeight:1.6 }}>
            Free forever plan. Generate your project blueprint in minutes. No credit card required.
          </p>
          <Link href="/signup" className="glow-btn" style={{ display:'inline-flex', alignItems:'center', gap:8, padding:'16px 40px', background:ac, color:'#000', borderRadius:999, fontSize:15, fontWeight:800, textDecoration:'none', boxShadow:`0 0 32px ${hexToRgba(ac,0.35)}` }}>
            Get started free <ArrowRight size={18} />
          </Link>
          <div style={{ marginTop:20, fontSize:12, color:'rgba(255,255,255,0.2)' }}>
            New project from scratch · generate your blueprint in minutes
          </div>
        </div>
      </section>

      {/* ══════════════════════════════════════════ FOOTER */}
      <footer style={{ borderTop:'1px solid rgba(255,255,255,0.06)', padding:'40px 24px', maxWidth:1100, margin:'0 auto', display:'flex', justifyContent:'space-between', alignItems:'center', flexWrap:'wrap', gap:20 }}>
        <div style={{ fontSize:13, fontWeight:800, color:'rgba(255,255,255,0.4)' }}>Reminisce</div>
        <div style={{ display:'flex', gap:32, flexWrap:'wrap' }}>
          {[['Docs','/docs'],['Engineering','/engineering'],['Capabilities','/capabilities'],['Upgrade','/upgrade']].map(([l,h]) => (
            <Link key={l} href={h} style={{ fontSize:12, color:'rgba(255,255,255,0.3)', textDecoration:'none' }}>{l}</Link>
          ))}
        </div>
        <div style={{ fontSize:11, color:'rgba(255,255,255,0.15)' }}>© 2025 Reminisce. All rights reserved.</div>
      </footer>
    </div>
  )
}
