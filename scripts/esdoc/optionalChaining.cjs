module.exports = {
  onHandleCode(event) {
    // remove any optional chaining use from the incoming doc
    event.data.code = event.data.code.replace(/\w+\?\.\w+/g, (substr) => {
      return substr.replace(/\?/g, '');
    });
  },
};
