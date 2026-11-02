cmake_minimum_required(VERSION 3.22.1)
project(hsscposter CXX)

add_library(node_runner SHARED node-jni.cpp)

target_include_directories(node_runner PRIVATE
        ${CMAKE_CURRENT_SOURCE_DIR}/include
        ${CMAKE_CURRENT_SOURCE_DIR}/include/node)

# nodejs-mobile ships one libnode.so per CPU type; consume the one that matches
# the ABI being built.
target_link_libraries(node_runner PRIVATE
        ${CMAKE_CURRENT_SOURCE_DIR}/../jniLibs/${ANDROID_ABI}/libnode.so
        android
        log)
