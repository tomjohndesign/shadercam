"use client"

import { useState, useRef, useCallback, useEffect, ReactNode, createContext, useContext } from "react"
import { motion, AnimatePresence, useMotionValue, useTransform, animate } from "motion/react"
import { ChevronRight, Copy, Check, GripVertical } from "lucide-react"

// DialKit Theme CSS Variables
const dialkitTheme = {
  "--dial-surface": "rgba(255, 255, 255, 0.05)",
  "--dial-surface-hover": "rgba(255, 255, 255, 0.1)",
  "--dial-surface-active": "rgba(255, 255, 255, 0.11)",
  "--dial-text-root": "#FFFFFF",
  "--dial-text-section": "rgba(255, 255, 255, 0.7)",
  "--dial-text-label": "rgba(255, 255, 255, 0.7)",
  "--dial-text-primary": "rgba(255, 255, 255, 0.95)",
  "--dial-text-secondary": "rgba(255, 255, 255, 0.6)",
  "--dial-text-tertiary": "rgba(255, 255, 255, 0.4)",
  "--dial-border": "rgba(255, 255, 255, 0.1)",
  "--dial-border-hover": "rgba(255, 255, 255, 0.15)",
  "--dial-glass-bg": "#212121",
  "--dial-backdrop-blur": "20px",
  "--dial-radius": "8px",
  "--dial-row-height": "36px",
  "--dial-shadow": "0 8px 32px rgba(0, 0, 0, 0.5)",
} as const

// Panel Context for nested components
const PanelContext = createContext<{
  onCopy?: () => void
}>({})

// =====================
// SLIDER COMPONENT
// =====================
interface SliderProps {
  label: string
  value: number
  onChange: (value: number) => void
  min?: number
  max?: number
  step?: number
  disabled?: boolean
}

function decimalsForStep(step: number): number {
  const s = step.toString()
  const dot = s.indexOf(".")
  return dot === -1 ? 0 : s.length - dot - 1
}

function roundValue(val: number, step: number): number {
  const raw = Math.round(val / step) * step
  return parseFloat(raw.toFixed(decimalsForStep(step)))
}

export function Slider({ label, value, onChange, min = 0, max = 1, step = 0.01, disabled = false }: SliderProps) {
  const wrapperRef = useRef<HTMLDivElement>(null)
  const [isInteracting, setIsInteracting] = useState(false)
  const [isHovered, setIsHovered] = useState(false)
  const [showInput, setShowInput] = useState(false)
  const [inputValue, setInputValue] = useState("")

  const percentage = ((value - min) / (max - min)) * 100
  const isActive = isInteracting || isHovered
  const fillPercent = useMotionValue(percentage)
  const fillWidth = useTransform(fillPercent, (pct) => `${pct}%`)
  const handleLeft = useTransform(fillPercent, (pct) => `max(5px, calc(${pct}% - 9px))`)

  useEffect(() => {
    if (!isInteracting) {
      fillPercent.jump(percentage)
    }
  }, [percentage, isInteracting, fillPercent])

  const positionToValue = useCallback(
    (clientX: number) => {
      if (!wrapperRef.current) return value
      const rect = wrapperRef.current.getBoundingClientRect()
      const percent = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
      const rawValue = min + percent * (max - min)
      return roundValue(Math.max(min, Math.min(max, rawValue)), step)
    },
    [min, max, step, value],
  )

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (disabled) return
      e.preventDefault()
      setIsInteracting(true)
      const newValue = positionToValue(e.clientX)
      onChange(newValue)
      fillPercent.set(((newValue - min) / (max - min)) * 100)
      ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    },
    [disabled, positionToValue, onChange, fillPercent, min, max],
  )

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!isInteracting || disabled) return
      const newValue = positionToValue(e.clientX)
      onChange(newValue)
      fillPercent.set(((newValue - min) / (max - min)) * 100)
    },
    [isInteracting, disabled, positionToValue, onChange, fillPercent, min, max],
  )

  const handlePointerUp = useCallback(() => {
    setIsInteracting(false)
  }, [])

  const handleValueClick = () => {
    if (disabled) return
    setInputValue(value.toFixed(decimalsForStep(step)))
    setShowInput(true)
  }

  const handleInputBlur = () => {
    const parsed = parseFloat(inputValue)
    if (!isNaN(parsed)) {
      onChange(Math.max(min, Math.min(max, roundValue(parsed, step))))
    }
    setShowInput(false)
  }

  const handleInputKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleInputBlur()
    } else if (e.key === "Escape") {
      setShowInput(false)
    }
  }

  const decimals = decimalsForStep(step)
  const displayValue = value.toFixed(decimals)

  return (
    <div
      ref={wrapperRef}
      className="relative"
      style={{ height: "var(--dial-row-height)" }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <div
        className="absolute inset-0 rounded-lg cursor-pointer select-none overflow-hidden touch-none transition-colors"
        style={{
          background: isActive ? "var(--dial-surface-hover)" : "var(--dial-surface)",
          borderRadius: "var(--dial-radius)",
          opacity: disabled ? 0.5 : 1,
          pointerEvents: disabled ? "none" : "auto",
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        {/* Fill */}
        <motion.div
          className="absolute top-0 bottom-0 left-0 pointer-events-none"
          style={{
            width: fillWidth,
            background: isActive ? "rgba(255, 255, 255, 0.15)" : "rgba(255, 255, 255, 0.08)",
            transition: "background 0.15s",
          }}
        />

        {/* Handle */}
        <motion.div
          className="absolute top-1/2 -translate-y-1/2 pointer-events-none"
          style={{
            left: handleLeft,
            width: "3px",
            height: "20px",
            borderRadius: "999px",
            background: "rgba(255, 255, 255, 0.8)",
          }}
        />

        {/* Hashmarks (show when active) */}
        {isActive && (
          <div className="absolute inset-0 pointer-events-none">
            {[0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9].map((pos) => (
              <div
                key={pos}
                className="absolute top-1/2 -translate-y-1/2"
                style={{
                  left: `${pos * 100}%`,
                  width: "1px",
                  height: "8px",
                  borderRadius: "999px",
                  background: "rgba(255, 255, 255, 0.15)",
                  transform: "translateX(-50%) translateY(-50%)",
                }}
              />
            ))}
          </div>
        )}

        {/* Label */}
        <span
          className="absolute left-[10px] top-1/2 -translate-y-1/2 text-[13px] font-medium pointer-events-none transition-colors"
          style={{ color: "var(--dial-text-label)" }}
        >
          {label}
        </span>

        {/* Value */}
        {showInput ? (
          <input
            autoFocus
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onBlur={handleInputBlur}
            onKeyDown={handleInputKeyDown}
            className="absolute right-[10px] top-1/2 -translate-y-1/2 w-[6ch] text-right text-[13px] font-medium font-mono bg-transparent border-none outline-none"
            style={{ color: "#fff" }}
          />
        ) : (
          <span
            onClick={(e) => {
              e.stopPropagation()
              handleValueClick()
            }}
            className="absolute right-[10px] top-1/2 -translate-y-1/2 text-[13px] font-medium font-mono cursor-text transition-colors"
            style={{
              color: isActive ? "#fff" : "var(--dial-text-label)",
              borderBottom: "1px solid transparent",
            }}
          >
            {displayValue}
          </span>
        )}
      </div>
    </div>
  )
}

// =====================
// TOGGLE COMPONENT
// =====================
interface ToggleProps {
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
}

export function Toggle({ label, checked, onChange, disabled = false }: ToggleProps) {
  return (
    <div
      className="flex items-center justify-between cursor-pointer select-none transition-colors"
      style={{
        padding: "10px 16px",
        background: "var(--dial-surface)",
        borderRadius: "var(--dial-radius)",
        opacity: disabled ? 0.5 : 1,
        pointerEvents: disabled ? "none" : "auto",
      }}
      onClick={() => !disabled && onChange(!checked)}
      onMouseEnter={(e) => (e.currentTarget.style.background = "var(--dial-surface-hover)")}
      onMouseLeave={(e) => (e.currentTarget.style.background = "var(--dial-surface)")}
    >
      <span
        className="text-[13px] font-medium transition-colors"
        style={{ color: checked ? "var(--dial-text-primary)" : "var(--dial-text-label)" }}
      >
        {label}
      </span>
      <div
        className="relative transition-colors"
        style={{
          width: "36px",
          height: "20px",
          borderRadius: "10px",
          background: checked ? "rgba(255, 255, 255, 0.3)" : "var(--dial-surface-active)",
        }}
      >
        <motion.div
          className="absolute top-[2px]"
          style={{
            width: "16px",
            height: "16px",
            borderRadius: "8px",
            background: "rgba(255, 255, 255, 0.8)",
          }}
          animate={{ left: checked ? "18px" : "2px" }}
          transition={{ type: "spring", stiffness: 500, damping: 30 }}
        />
      </div>
    </div>
  )
}

// =====================
// SEGMENTED CONTROL
// =====================
interface SegmentedControlProps {
  value: string
  options: { value: string; label: string }[]
  onChange: (value: string) => void
  disabled?: boolean
}

export function SegmentedControl({ value, options, onChange, disabled = false }: SegmentedControlProps) {
  const activeIndex = options.findIndex((o) => o.value === value)

  return (
    <div
      className="relative flex"
      style={{
        padding: "2px",
        borderRadius: "var(--dial-radius)",
        opacity: disabled ? 0.5 : 1,
        pointerEvents: disabled ? "none" : "auto",
      }}
    >
      {/* Animated pill */}
      <motion.div
        className="absolute top-[2px] bottom-[2px] pointer-events-none"
        style={{
          background: "var(--dial-surface-active)",
          borderRadius: "6px",
          width: `${100 / options.length}%`,
        }}
        animate={{ left: `${(activeIndex / options.length) * 100}%` }}
        transition={{ type: "spring", stiffness: 500, damping: 30 }}
      />
      {options.map((option) => (
        <button
          key={option.value}
          onClick={() => onChange(option.value)}
          className="relative z-10 flex-1 text-[13px] font-medium border-none cursor-pointer transition-colors bg-transparent"
          style={{
            padding: "8px 12px",
            color: option.value === value ? "rgba(255, 255, 255, 0.8)" : "var(--dial-text-label)",
          }}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

// =====================
// SELECT CONTROL
// =====================
interface SelectControlProps {
  label: string
  value: string
  options: { value: string; label: string }[]
  onChange: (value: string) => void
  disabled?: boolean
}

export function SelectControl({ label, value, options, onChange, disabled = false }: SelectControlProps) {
  const [isOpen, setIsOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)

  const selectedOption = options.find((o) => o.value === value)

  useEffect(() => {
    if (isOpen) {
      const handleClickOutside = (e: MouseEvent) => {
        if (
          dropdownRef.current &&
          !dropdownRef.current.contains(e.target as Node) &&
          triggerRef.current &&
          !triggerRef.current.contains(e.target as Node)
        ) {
          setIsOpen(false)
        }
      }
      document.addEventListener("mousedown", handleClickOutside)
      return () => document.removeEventListener("mousedown", handleClickOutside)
    }
  }, [isOpen])

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        onClick={() => !disabled && setIsOpen(!isOpen)}
        className="flex items-center justify-between w-full border-none cursor-pointer transition-colors"
        style={{
          height: "var(--dial-row-height)",
          padding: "0 12px",
          background: isOpen ? "var(--dial-surface-active)" : "var(--dial-surface)",
          borderRadius: "var(--dial-radius)",
          opacity: disabled ? 0.5 : 1,
        }}
        onMouseEnter={(e) => !isOpen && (e.currentTarget.style.background = "var(--dial-surface-hover)")}
        onMouseLeave={(e) => !isOpen && (e.currentTarget.style.background = "var(--dial-surface)")}
      >
        <span className="text-[13px] font-medium" style={{ color: "var(--dial-text-label)" }}>
          {label}
        </span>
        <div className="flex items-center gap-2">
          <span
            className="text-[13px] font-medium overflow-hidden text-ellipsis whitespace-nowrap"
            style={{ color: "var(--dial-text-label)" }}
          >
            {selectedOption?.label || value}
          </span>
          <ChevronRight
            className="transition-transform"
            style={{
              width: "16px",
              height: "16px",
              opacity: 0.6,
              transform: isOpen ? "rotate(90deg)" : "rotate(0deg)",
            }}
          />
        </div>
      </button>

      <AnimatePresence>
        {isOpen && (
          <motion.div
            ref={dropdownRef}
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.15 }}
            className="absolute top-full left-0 right-0 mt-1 z-50"
            style={{
              background: "var(--dial-glass-bg)",
              border: "1px solid var(--dial-border)",
              borderRadius: "var(--dial-radius)",
              padding: "4px",
              boxShadow: "0 8px 24px rgba(0, 0, 0, 0.4)",
            }}
          >
            {options.map((option) => (
              <button
                key={option.value}
                onClick={() => {
                  onChange(option.value)
                  setIsOpen(false)
                }}
                className="block w-full text-left border-none cursor-pointer transition-colors"
                style={{
                  padding: "8px 10px",
                  background: option.value === value ? "var(--dial-surface-active)" : "transparent",
                  borderRadius: "6px",
                  color: option.value === value ? "var(--dial-text-primary)" : "var(--dial-text-label)",
                  fontSize: "13px",
                  fontWeight: 500,
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "var(--dial-surface-hover)")}
                onMouseLeave={(e) =>
                  (e.currentTarget.style.background =
                    option.value === value ? "var(--dial-surface-active)" : "transparent")
                }
              >
                {option.label}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// =====================
// BUTTON COMPONENT
// =====================
interface ButtonProps {
  label: string
  onClick: () => void
  disabled?: boolean
}

export function Button({ label, onClick, disabled = false }: ButtonProps) {
  return (
    <button
      onClick={() => !disabled && onClick()}
      className="w-full border-none cursor-pointer transition-colors"
      style={{
        padding: "10px 16px",
        background: "var(--dial-surface)",
        borderRadius: "var(--dial-radius)",
        color: "var(--dial-text-secondary)",
        fontSize: "13px",
        fontWeight: 500,
        opacity: disabled ? 0.5 : 1,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "var(--dial-surface-hover)"
        e.currentTarget.style.color = "var(--dial-text-primary)"
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "var(--dial-surface)"
        e.currentTarget.style.color = "var(--dial-text-secondary)"
      }}
    >
      {label}
    </button>
  )
}

// =====================
// FOLDER COMPONENT
// =====================
interface FolderProps {
  title: string
  defaultOpen?: boolean
  children: ReactNode
}

export function Folder({ title, defaultOpen = true, children }: FolderProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen)

  return (
    <div
      style={{
        borderTop: "1px solid rgba(255, 255, 255, 0.06)",
        borderBottom: "1px solid rgba(255, 255, 255, 0.06)",
        marginTop: "4px",
        marginBottom: "4px",
      }}
    >
      <div
        className="flex items-center justify-between cursor-pointer select-none"
        style={{ height: "var(--dial-row-height)" }}
        onClick={() => setIsOpen(!isOpen)}
      >
        <span className="text-[13px] font-semibold transition-colors" style={{ color: "var(--dial-text-section)" }}>
          {title}
        </span>
        <ChevronRight
          className="transition-transform"
          style={{
            width: "16px",
            height: "16px",
            color: "var(--dial-text-section)",
            transform: isOpen ? "rotate(90deg)" : "rotate(0deg)",
          }}
        />
      </div>
      <AnimatePresence initial={false}>
        {isOpen && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            style={{ overflow: "hidden" }}
          >
            <div className="flex flex-col gap-[6px] pb-[10px]">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// =====================
// FLOATING PANEL
// =====================
interface FloatingPanelProps {
  title: string
  position?: "top-right" | "top-left" | "bottom-right" | "bottom-left"
  children: ReactNode
  onCopy?: () => void
}

export function FloatingPanel({ title, position = "top-right", children, onCopy }: FloatingPanelProps) {
  const [isCollapsed, setIsCollapsed] = useState(false)
  const [copied, setCopied] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const dragOffset = useRef({ x: 0, y: 0 })
  const [panelPosition, setPanelPosition] = useState<{ x: number; y: number } | null>(null)

  // Get initial position based on position prop
  useEffect(() => {
    if (!panelRef.current || panelPosition !== null) return
    const rect = panelRef.current.getBoundingClientRect()
    let x = 16
    let y = 16
    if (position.includes("right")) x = window.innerWidth - rect.width - 16
    if (position.includes("bottom")) y = window.innerHeight - rect.height - 16
    setPanelPosition({ x, y })
  }, [position, panelPosition])

  const handleCopy = () => {
    onCopy?.()
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const handleDragStart = (e: React.PointerEvent) => {
    if (!panelRef.current) return
    setIsDragging(true)
    const rect = panelRef.current.getBoundingClientRect()
    dragOffset.current = {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    }
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }

  const handleDragMove = (e: React.PointerEvent) => {
    if (!isDragging) return
    const x = Math.max(0, Math.min(window.innerWidth - 300, e.clientX - dragOffset.current.x))
    const y = Math.max(0, Math.min(window.innerHeight - 100, e.clientY - dragOffset.current.y))
    setPanelPosition({ x, y })
  }

  const handleDragEnd = () => {
    setIsDragging(false)
  }

  return (
    <motion.div
      ref={panelRef}
      className="fixed z-[9999]"
      style={{
        ...dialkitTheme,
        fontFamily: "system-ui, -apple-system, 'SF Pro Display', sans-serif",
        WebkitFontSmoothing: "antialiased",
        left: panelPosition?.x ?? 16,
        top: panelPosition?.y ?? 16,
        maxHeight: "calc(100vh - 32px)",
      }}
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.2 }}
    >
      <PanelContext.Provider value={{ onCopy: handleCopy }}>
        <motion.div
          className="overflow-y-auto"
          style={{
            background: "var(--dial-glass-bg)",
            border: "1px solid var(--dial-border)",
            borderRadius: isCollapsed ? "50%" : "14px",
            backdropFilter: "blur(var(--dial-backdrop-blur))",
            WebkitBackdropFilter: "blur(var(--dial-backdrop-blur))",
            padding: isCollapsed ? "12px" : "10px 12px 12px 12px",
            boxShadow: "var(--dial-shadow)",
            maxHeight: "calc(100vh - 80px)",
            minWidth: isCollapsed ? "auto" : "280px",
            scrollbarWidth: "none",
            msOverflowStyle: "none",
          }}
          layout
          transition={{ type: "spring", stiffness: 400, damping: 30 }}
        >
          {/* Header */}
          <div
            className="flex items-center justify-between"
            style={{
              paddingBottom: isCollapsed ? 0 : "6px",
              marginBottom: isCollapsed ? 0 : "12px",
              borderBottom: isCollapsed ? "none" : "1px solid rgba(255, 255, 255, 0.06)",
            }}
          >
            {!isCollapsed && (
              <div className="flex items-center gap-[6px] flex-1">
                {/* Drag handle */}
                <div
                  className="cursor-grab active:cursor-grabbing p-1 -ml-1 rounded hover:bg-white/10 transition-colors"
                  onPointerDown={handleDragStart}
                  onPointerMove={handleDragMove}
                  onPointerUp={handleDragEnd}
                  onPointerCancel={handleDragEnd}
                >
                  <GripVertical className="w-4 h-4" style={{ color: "var(--dial-text-section)" }} />
                </div>
                <span className="text-[15px] font-semibold" style={{ color: "var(--dial-text-root)" }}>
                  {title}
                </span>
              </div>
            )}

            <div className="flex items-center gap-1">
              {!isCollapsed && onCopy && (
                <button
                  onClick={handleCopy}
                  className="flex items-center justify-center w-5 h-5 p-0 bg-transparent border-none cursor-pointer"
                >
                  {copied ? (
                    <Check className="w-[14px] h-[14px]" style={{ color: "var(--dial-text-section)" }} />
                  ) : (
                    <Copy className="w-[14px] h-[14px]" style={{ color: "var(--dial-text-section)" }} />
                  )}
                </button>
              )}
              <button
                onClick={() => setIsCollapsed(!isCollapsed)}
                className="flex items-center justify-center w-5 h-5 p-0 bg-transparent border-none cursor-pointer"
              >
                <ChevronRight
                  className="transition-transform"
                  style={{
                    width: "16px",
                    height: "16px",
                    color: isCollapsed ? "#fff" : "var(--dial-text-section)",
                    transform: isCollapsed ? "rotate(180deg)" : "rotate(0deg)",
                  }}
                />
              </button>
            </div>
          </div>

          {/* Content */}
          <AnimatePresence>
            {!isCollapsed && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="flex flex-col gap-[6px]"
              >
                {children}
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      </PanelContext.Provider>
    </motion.div>
  )
}
