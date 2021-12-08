/* eslint-disable max-classes-per-file */

const {
  byteArray,
  gi: { St, GLib, Clutter },
  ui: { main, panelMenu },
} = imports

function sum(arr, propName = null) {
  return arr.reduce(
    (result, iter) => result + (propName == null ? iter : iter[propName]),
    0,
  )
}

function formatBytes(bytes) {
  bytes /= 1024
  if (bytes > 1024) {
    bytes /= 1024
    if (bytes > 1024) {
      bytes /= 1024
      return `${Math.ceil(bytes)} GB`
    }
    return `${Math.ceil(bytes)} MB`
  }
  return `${Math.ceil(bytes)} KB`
}

class Indicator {
  constructor(name, labelProps = {}) {
    this.button = new panelMenu.Button(0, name, false)
    this.label = new St.Label(labelProps)

    this.button.add_child(this.label)
    main.panel.addToStatusArea(name, this.button)
  }

  destroy() {
    this.button.destroy()
  }
}

class SamplingIndicator extends Indicator {
  constructor(name, sampleRate, labelProps = {}) {
    super(name, labelProps)

    this.sampleRate = sampleRate
    this.samples = []

    this.timeout = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      this.sampleRate,
      () => this.tick(),
    )
  }

  destroy() {
    if (this.timeout) {
      GLib.source_remove(this.timeout)
      this.timeout = null
    }
    super.destroy()
  }

  private

  tick() {
    if (this.samples.length >= Math.floor(1000 / this.sampleRate)) {
      this.samples.shift()
    }

    this.sample()

    if (this.samples.length > 0) {
      this.label.text = this.format()
    }

    return GLib.SOURCE_CONTINUE
  }
}

function getAllInterfaceStats() {
  function parseAtOffset(cols, offset) {
    return [
      "bytes",
      "packets",
      "errs",
      "drop",
      "fifo",
      "frame",
      "compressed",
      "multicast",
    ].reduce(
      (acc, name, index) => ({
        ...acc,
        [name]: Number(cols[offset + index]),
      }),
      {},
    )
  }

  const result = {}
  const [, out] = GLib.file_get_contents("/proc/net/dev")
  const lines = byteArray.toString(out).split("\n")

  for (let i = 2; i < lines.length; i++) {
    const line = lines[i].split(":")
    if (line.length > 1) {
      const iface = line[0].trim()
      const cols = line[1].trim().split(/\s+/)
      result[iface] = {
        received: parseAtOffset(cols, 0),
        transmitted: parseAtOffset(cols, 8),
      }
    }
  }
  return result
}

function isBlacklistedInterface(iface) {
  const blacklist = [
    /^lo/,
    /^ifb[0-9]+/,
    /^lxdbr[0-9]+/,
    /^virbr[0-9]+/,
    /^br[0-9]+/,
    /^vnet[0-9]+/,
    /^tun[0-9]+/,
    /^tap[0-9]+/,
  ]

  for (const regex of blacklist) {
    if (regex.test(iface)) {
      return true
    }
  }

  return false
}

function getDefaultInterfaceStats() {
  const stats = getAllInterfaceStats()
  for (const iface in stats) {
    if (!isBlacklistedInterface(iface)) {
      return stats[iface]
    }
  }

  return null
}

class NetworkSpeedIndicator extends SamplingIndicator {
  constructor() {
    super("Network Speed", 60, {
      text: "---",
      style: "font-size: x-small; text-align: right; width: 6em;",
      y_align: Clutter.ActorAlign.CENTER,
    })
  }

  sample() {
    const stats = getDefaultInterfaceStats()
    if (stats) {
      const {
        received: { bytes: rx },
        transmitted: { bytes: tx },
      } = stats

      if (this.last) {
        this.samples.push({
          rx: rx - this.last.rx,
          tx: tx - this.last.tx,
        })
      }
      this.last = { rx, tx }
    }
  }

  format() {
    return [
      `↓${formatBytes(sum(this.samples, "rx"))}/s`,
      `↑${formatBytes(sum(this.samples, "tx"))}/s`,
    ].join("\n")
  }
}

function getMemoryStats() {
  const result = {}
  const [, out] = GLib.file_get_contents("/proc/meminfo")
  const lines = byteArray.toString(out).split("\n")
  for (const line of lines) {
    const [name, valueUnit] = line.split(":").map((s) => s.trim())
    if (name && valueUnit) {
      const [value] = valueUnit.split(/\s+/)
      result[name] = Number(value)
    }
  }
  return result
}

class MemoryIndicator extends SamplingIndicator {
  constructor() {
    super("Memory", 60, {
      text: "---",
      style: "font-size: x-small; text-align: right; width: 4em;",
      y_align: Clutter.ActorAlign.CENTER,
    })
  }

  sample() {
    const stats = getMemoryStats()
    this.samples.push({
      used: stats.MemTotal - stats.MemAvailable,
      swap: stats.SwapTotal - stats.SwapFree,
    })
  }

  format() {
    return [
      formatBytes((sum(this.samples, "used") / this.samples.length) * 1024),
      formatBytes((sum(this.samples, "swap") / this.samples.length) * 1024),
    ].join("\n")
  }
}

function getCPUTemperature() {
  const [, out] = GLib.file_get_contents(
    "/sys/class/thermal/thermal_zone0/temp",
  )
  const lines = byteArray.toString(out).split("\n")
  const [temp] = lines[0].split(/\s+/).map(Number)
  return temp / 1000
}

class CpuIndicator extends SamplingIndicator {
  constructor() {
    super("CPU", 60, {
      text: "---",
      style: "font-size: x-small; text-align: right; width: 3em;",
      y_align: Clutter.ActorAlign.CENTER,
    })
  }

  sample() {
    const [, out] = GLib.file_get_contents("/proc/stat")
    const lines = byteArray.toString(out).split("\n")
    const [, ...values] = lines[0].split(/\s+/).map(Number)

    this.samples.push({
      total: values.reduce((a, b) => a + b),
      idle: values[3] + values[4],
      temperature: getCPUTemperature(),
    })
  }

  format() {
    const total =
      this.samples[this.samples.length - 1].total - this.samples[0].total
    const idle =
      this.samples[this.samples.length - 1].idle - this.samples[0].idle
    const usage = ((total - idle) / total) * 100

    return [
      `${Math.floor(usage)}%`,
      `${Math.round(sum(this.samples, "temperature") / this.samples.length)}ºC`,
    ].join("\n")
  }
}

class Extension {
  enable() {
    this.indicators = [
      new MemoryIndicator(),
      new CpuIndicator(),
      new NetworkSpeedIndicator(),
    ]
  }

  disable() {
    this.indicators.forEach((indicator) => indicator.destroy())
  }
}

function init() {
  return new Extension()
}
