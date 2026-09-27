import {render,preload,defaults,total} from './renderer.js';
const canvas=document.querySelector('canvas'),g=canvas.getContext('2d');let c=defaults,t=0,playing=false,last=0;const seek=document.querySelector('#seek'),play=document.querySelector('#play');const fmt=v=>`${Math.floor(v/60).toString().padStart(2,'0')}:${Math.floor(v%60).toString().padStart(2,'0')}`;
await preload(c);window.film={render(time){t=time;render(g,t,c)},async configure(config){c=config;await preload(c);render(g,t,c)},duration:()=>total(c),ready:true};
if(new URLSearchParams(location.search).has('render'))document.body.classList.add('render');
function update(){seek.max=total(c);seek.value=t;document.querySelector('#time').textContent=`${fmt(t)} / ${fmt(total(c))}`;play.textContent=playing?'暂停':'播放';render(g,t,c)}
function toggle(){if(t>=total(c))t=0;playing=!playing;last=performance.now();update()}
play.onclick=toggle;seek.oninput=()=>{t=Number(seek.value);update()};document.querySelector('#full').onclick=()=>canvas.requestFullscreen();document.addEventListener('keydown',e=>{if(e.target instanceof HTMLInputElement)return;if(e.code==='Space'){e.preventDefault();toggle()}if(['ArrowLeft','ArrowRight'].includes(e.code)){e.preventDefault();playing=false;t=Math.max(0,Math.min(total(c),t+(e.code==='ArrowRight'?1:-1)/30));update()}});
function frame(now){if(playing){t=Math.min(total(c),t+(now-last)/1000);if(t>=total(c))playing=false;update()}last=now;requestAnimationFrame(frame)}update();requestAnimationFrame(frame);
