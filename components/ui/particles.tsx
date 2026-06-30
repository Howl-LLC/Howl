// SPDX-License-Identifier: AGPL-3.0-only
//
// Adapted from Magic UI (https://magicui.design).
// The adapted portions retain their original license:
//
//   MIT License
//   Copyright (c) Magic UI authors
//
//   Permission is hereby granted, free of charge, to any person obtaining a copy
//   of this software and associated documentation files (the "Software"), to deal
//   in the Software without restriction, including without limitation the rights
//   to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
//   copies of the Software, and to permit persons to whom the Software is
//   furnished to do so, subject to the following conditions:
//
//   The above copyright notice and this permission notice shall be included in
//   all copies or substantial portions of the Software.
//
//   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
//   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
//   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
//   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
//   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
//   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
//   SOFTWARE.
//
// Modifications Copyright (C) 2026 Howl LLC, distributed as part of Howl under
// the GNU Affero General Public License v3.0 only (AGPL-3.0-only).
import React, {
  useEffect,
  useRef,
  type ComponentPropsWithoutRef,
} from "react"

import { cn } from "@/lib/utils"
import { getStoredAdvanced } from "../../utils/settingsStorage"
import { isAppVisible, onVisibilityChange } from "../../hooks/useAppVisible"


interface ParticlesProps extends ComponentPropsWithoutRef<"div"> {
  className?: string
  quantity?: number
  staticity?: number
  ease?: number
  size?: number
  refresh?: boolean
  color?: string
  vx?: number
  vy?: number
}

function hexToRgb(hex: string): number[] {
  hex = hex.replace("#", "")

  if (hex.length === 3) {
    hex = hex
      .split("")
      .map((char) => char + char)
      .join("")
  }

  const hexInt = parseInt(hex, 16)
  const red = (hexInt >> 16) & 255
  const green = (hexInt >> 8) & 255
  const blue = hexInt & 255
  return [red, green, blue]
}

type Circle = {
  x: number
  y: number
  translateX: number
  translateY: number
  size: number
  alpha: number
  targetAlpha: number
  dx: number
  dy: number
  magnetism: number
}

export const Particles: React.FC<ParticlesProps> = ({
  className = "",
  quantity = 100,
  staticity = 50,
  ease = 50,
  size = 0.4,
  refresh = false,
  color = "#ffffff",
  vx = 0,
  vy = 0,
  ...props
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const canvasContainerRef = useRef<HTMLDivElement>(null)
  const context = useRef<CanvasRenderingContext2D | null>(null)
  const circles = useRef<Circle[]>([])
  const mouse = useRef<{ x: number; y: number }>({ x: 0, y: 0 })
  const canvasSize = useRef<{ w: number; h: number }>({ w: 0, h: 0 })
  const dpr = typeof window !== "undefined" ? window.devicePixelRatio : 1
  const rafID = useRef<number | null>(null)
  const resizeTimeout = useRef<NodeJS.Timeout | null>(null)
  const initCanvasRef = useRef<() => void>(() => {})
  const animateRef = useRef<() => void>(() => {})

  useEffect(() => {
    if (!getStoredAdvanced().hardwareAcceleration) return
    if (canvasRef.current) {
      context.current = canvasRef.current.getContext("2d")
    }
    initCanvasRef.current()
    animateRef.current()

    const handleResize = () => {
      if (resizeTimeout.current) {
        clearTimeout(resizeTimeout.current)
      }
      resizeTimeout.current = setTimeout(() => {
        if (!canvasRef.current) return
        initCanvasRef.current()
      }, 200)
    }

    let cachedRect: DOMRect | null = null
    const updateRect = () => { if (canvasRef.current) cachedRect = canvasRef.current.getBoundingClientRect() }
    updateRect()

    let mouseMoveRaf = 0
    const handleMouseMove = (event: MouseEvent) => {
      if (mouseMoveRaf) return
      mouseMoveRaf = requestAnimationFrame(() => {
        mouseMoveRaf = 0
        if (!canvasRef.current) return
        if (!cachedRect) updateRect()
        if (cachedRect) {
          const { w, h } = canvasSize.current
          const x = event.clientX - cachedRect.left - w / 2
          const y = event.clientY - cachedRect.top - h / 2
          const inside = x < w / 2 && x > -w / 2 && y < h / 2 && y > -h / 2
          if (inside) {
            mouse.current.x = x
            mouse.current.y = y
          }
        }
      })
    }

    const handleResizeOuter = () => { cachedRect = null; handleResize() }

    window.addEventListener("resize", handleResizeOuter)
    window.addEventListener("mousemove", handleMouseMove)

    // Two-gate loop control: host window visibility AND canvas-in-viewport.
    // Either being false should stop the RAF; both being true (re)start it.
    const startIfNeeded = () => {
      if (visibleRef.current && intersectingRef.current && rafID.current == null) {
        rafID.current = window.requestAnimationFrame(animateRef.current)
      }
    }

    const unsubscribeVisibility = onVisibilityChange((v) => {
      visibleRef.current = v
      if (v) startIfNeeded()
      else if (rafID.current != null) {
        window.cancelAnimationFrame(rafID.current)
        rafID.current = null
      }
    })

    let intersectionObserver: IntersectionObserver | null = null
    if (canvasContainerRef.current) {
      intersectionObserver = new IntersectionObserver(
        ([entry]) => {
          intersectingRef.current = entry.isIntersecting
          if (entry.isIntersecting) startIfNeeded()
          else if (rafID.current != null) {
            window.cancelAnimationFrame(rafID.current)
            rafID.current = null
          }
        },
        { threshold: 0 },
      )
      intersectionObserver.observe(canvasContainerRef.current)
    }

    return () => {
      if (rafID.current != null) {
        window.cancelAnimationFrame(rafID.current)
      }
      if (resizeTimeout.current) {
        clearTimeout(resizeTimeout.current)
      }
      if (mouseMoveRaf) cancelAnimationFrame(mouseMoveRaf)
      unsubscribeVisibility()
      intersectionObserver?.disconnect()
      window.removeEventListener("resize", handleResizeOuter)
      window.removeEventListener("mousemove", handleMouseMove)
    }
  }, [color])

  useEffect(() => {
    initCanvasRef.current()
  }, [refresh])

  const initCanvas = () => {
    resizeCanvas()
    drawParticles()
  }

  const resizeCanvas = () => {
    if (canvasContainerRef.current && canvasRef.current && context.current) {
      canvasSize.current.w = canvasContainerRef.current.offsetWidth
      canvasSize.current.h = canvasContainerRef.current.offsetHeight

      canvasRef.current.width = canvasSize.current.w * dpr
      canvasRef.current.height = canvasSize.current.h * dpr
      canvasRef.current.style.width = `${canvasSize.current.w}px`
      canvasRef.current.style.height = `${canvasSize.current.h}px`
      context.current.scale(dpr, dpr)

      // Clear existing particles and create new ones with exact quantity
      circles.current = []
      for (let i = 0; i < quantity; i++) {
        const circle = circleParams()
        drawCircle(circle)
      }
    }
  }

  const circleParams = (): Circle => {
    const x = Math.floor(Math.random() * canvasSize.current.w)
    const y = Math.floor(Math.random() * canvasSize.current.h)
    const translateX = 0
    const translateY = 0
    const pSize = Math.floor(Math.random() * 2) + size
    const alpha = 0
    const targetAlpha = parseFloat((Math.random() * 0.6 + 0.1).toFixed(1))
    const dx = (Math.random() - 0.5) * 0.1
    const dy = (Math.random() - 0.5) * 0.1
    const magnetism = 0.1 + Math.random() * 4
    return {
      x,
      y,
      translateX,
      translateY,
      size: pSize,
      alpha,
      targetAlpha,
      dx,
      dy,
      magnetism,
    }
  }

  const rgb = hexToRgb(color)

  const drawCircle = (circle: Circle, update = false) => {
    if (context.current) {
      const { x, y, translateX, translateY, size, alpha } = circle
      context.current.translate(translateX, translateY)
      context.current.beginPath()
      context.current.arc(x, y, size, 0, 2 * Math.PI)
      context.current.fillStyle = `rgba(${rgb.join(", ")}, ${alpha})`
      context.current.fill()
      context.current.setTransform(dpr, 0, 0, dpr, 0, 0)

      if (!update) {
        circles.current.push(circle)
      }
    }
  }

  const clearContext = () => {
    if (context.current) {
      context.current.clearRect(
        0,
        0,
        canvasSize.current.w,
        canvasSize.current.h
      )
    }
  }

  const drawParticles = () => {
    clearContext()
    const particleCount = quantity
    for (let i = 0; i < particleCount; i++) {
      const circle = circleParams()
      drawCircle(circle)
    }
  }

  const remapValue = (
    value: number,
    start1: number,
    end1: number,
    start2: number,
    end2: number
  ): number => {
    const remapped =
      ((value - start1) * (end2 - start2)) / (end1 - start1) + start2
    return remapped > 0 ? remapped : 0
  }

  const visibleRef = useRef(typeof window !== "undefined" ? isAppVisible() : true)
  const intersectingRef = useRef(true)

  const animate = () => {
    if (!canvasRef.current || !context.current) return
    // Skip the frame entirely while either gate is closed. Browsers throttle
    // RAF on hidden tabs but not on alt-tabbed windows or canvases scrolled
    // out of view, so both gates are needed to keep idle GPU at zero.
    if (!visibleRef.current || !intersectingRef.current) {
      rafID.current = null
      return
    }
    clearContext()
    circles.current.forEach((circle: Circle, i: number) => {
      // Handle the alpha value
      const edge = [
        circle.x + circle.translateX - circle.size, // distance from left edge
        canvasSize.current.w - circle.x - circle.translateX - circle.size, // distance from right edge
        circle.y + circle.translateY - circle.size, // distance from top edge
        canvasSize.current.h - circle.y - circle.translateY - circle.size, // distance from bottom edge
      ]
      const closestEdge = edge.reduce((a, b) => Math.min(a, b))
      const remapClosestEdge = parseFloat(
        remapValue(closestEdge, 0, 20, 0, 1).toFixed(2)
      )
      if (remapClosestEdge > 1) {
        circle.alpha += 0.02
        if (circle.alpha > circle.targetAlpha) {
          circle.alpha = circle.targetAlpha
        }
      } else {
        circle.alpha = circle.targetAlpha * remapClosestEdge
      }
      circle.x += circle.dx + vx
      circle.y += circle.dy + vy
      circle.translateX +=
        (mouse.current.x / (staticity / circle.magnetism) - circle.translateX) /
        ease
      circle.translateY +=
        (mouse.current.y / (staticity / circle.magnetism) - circle.translateY) /
        ease

      drawCircle(circle, true)

      // circle gets out of the canvas
      if (
        circle.x < -circle.size ||
        circle.x > canvasSize.current.w + circle.size ||
        circle.y < -circle.size ||
        circle.y > canvasSize.current.h + circle.size
      ) {
        // remove the circle from the array
        circles.current.splice(i, 1)
        // create a new circle
        const newCircle = circleParams()
        drawCircle(newCircle)
      }
    })
    rafID.current = window.requestAnimationFrame(animateRef.current)
  }

  initCanvasRef.current = initCanvas
  animateRef.current = animate

  return (
    <div
      className={cn("pointer-events-none", className)}
      ref={canvasContainerRef}
      aria-hidden="true"
      {...props}
    >
      <canvas ref={canvasRef} className="size-full" />
    </div>
  )
}
