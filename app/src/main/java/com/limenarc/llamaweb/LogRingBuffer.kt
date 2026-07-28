package com.limenarc.llamaweb

/** Bounded, thread-safe line buffer for the llama-server stdout/stderr tail. */
class LogRingBuffer(private val capacity: Int = 500) {
    private val lines = ArrayDeque<String>(capacity)

    @Synchronized
    fun add(line: String) {
        if (lines.size >= capacity) {
            lines.removeFirst()
        }
        lines.addLast(line)
    }

    @Synchronized
    fun clear() {
        lines.clear()
    }

    @Synchronized
    fun snapshot(): List<String> = lines.toList()

    fun tail(maxLines: Int): String = snapshot().takeLast(maxLines).joinToString("\n")
}
