#include <jni.h>

#include <string>
#include <vector>

#include "node.h"

// Runs libnode inside the app process. nodejs-mobile is a library, not an
// executable, so no file in the app's data directory is ever executed.
extern "C" JNIEXPORT jint JNICALL
Java_com_hssc_poster_NodeRunner_startNode(JNIEnv* env, jclass, jobjectArray arguments) {
    const jsize count = env->GetArrayLength(arguments);
    std::vector<std::string> storage;
    std::vector<char*> argv;
    storage.reserve(count);
    argv.reserve(count + 1);

    for (jsize i = 0; i < count; ++i) {
        auto item = static_cast<jstring>(env->GetObjectArrayElement(arguments, i));
        const char* chars = env->GetStringUTFChars(item, nullptr);
        storage.emplace_back(chars);
        env->ReleaseStringUTFChars(item, chars);
        env->DeleteLocalRef(item);
    }
    for (auto& value : storage) {
        argv.push_back(const_cast<char*>(value.c_str()));
    }
    argv.push_back(nullptr);

    return node::Start(static_cast<int>(storage.size()), argv.data());
}
