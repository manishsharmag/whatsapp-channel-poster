package com.hssc.poster

/**
 * The only bridge into libnode.so. [startNode] blocks until Node exits, so it
 * must be called from a background thread — see [NodeService].
 */
object NodeRunner {
    init {
        System.loadLibrary("node")
        System.loadLibrary("node_runner")
    }

    @JvmStatic
    external fun startNode(arguments: Array<String>): Int
}
